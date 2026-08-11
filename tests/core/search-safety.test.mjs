import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { searchAios, searchMarkdownDir } from "../../packages/core/src/search.mjs";
import { createEvidenceReader } from "../../packages/core/src/evidence-reader.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-search-safety-"));
}

test("search rejects linked eligible files instead of following or silently omitting them", async () => {
  const root = tmpDir();
  const context = path.join(root, "context");
  const outside = path.join(root, "outside.md");
  fs.mkdirSync(context);
  fs.writeFileSync(outside, "# Outside\n\nOUTSIDE_SEARCH_CANARY\n");
  fs.symlinkSync(outside, path.join(context, "linked.md"));

  await assert.rejects(
    () => searchAios({ aiosPath: root, query: "OUTSIDE_SEARCH_CANARY", scope: "context" }),
    (error) => error?.code === "DOTAIOS_EVIDENCE_PATH_UNSAFE"
  );
});

test("search ignores an irrelevant linked asset while returning eligible Markdown", async () => {
  const root = tmpDir();
  const context = path.join(root, "context");
  const outsideAsset = path.join(root, "asset.bin");
  fs.mkdirSync(context);
  fs.writeFileSync(path.join(context, "safe.md"), "# Safe\n\nSAFE_SEARCH_CANARY\n");
  fs.writeFileSync(outsideAsset, "IRRELEVANT_ASSET_CANARY\n");
  fs.symlinkSync(outsideAsset, path.join(context, "asset.png"));

  const [group] = await searchAios({
    aiosPath: root,
    query: "SAFE_SEARCH_CANARY",
    scope: "context"
  });

  assert.equal(group.results.length, 1);
  assert.equal(group.results[0].file, "safe.md");
});

test("search never traverses an ineligible linked directory", async () => {
  const root = tmpDir();
  const context = path.join(root, "context");
  const outsideDirectory = path.join(root, "outside-directory");
  fs.mkdirSync(context);
  fs.mkdirSync(outsideDirectory);
  fs.writeFileSync(path.join(context, "safe.md"), "# Safe\n\nSAFE_DIRECTORY_SEARCH_CANARY\n");
  fs.writeFileSync(path.join(outsideDirectory, "secret.md"), "OUTSIDE_DIRECTORY_CANARY\n");
  fs.symlinkSync(outsideDirectory, path.join(context, "linked-directory"));

  const [safeGroup] = await searchAios({
    aiosPath: root,
    query: "SAFE_DIRECTORY_SEARCH_CANARY",
    scope: "context"
  });
  const [outsideGroup] = await searchAios({
    aiosPath: root,
    query: "OUTSIDE_DIRECTORY_CANARY",
    scope: "context"
  });

  assert.equal(safeGroup.results.length, 1);
  assert.equal(outsideGroup.results.length, 0);
});

test("search treats a configured external vault as an explicit authorized root", async () => {
  const tempRoot = tmpDir();
  const aiosPath = path.join(tempRoot, "aios");
  const vaultPath = path.join(tempRoot, "external-vault");
  fs.mkdirSync(aiosPath);
  fs.mkdirSync(vaultPath);
  fs.writeFileSync(path.join(vaultPath, "note.md"), "# External\n\nAUTHORIZED_VAULT_CANARY\n");

  const [group] = await searchAios({
    aiosPath,
    vaultPath,
    query: "AUTHORIZED_VAULT_CANARY",
    scope: "vault"
  });

  assert.equal(group.scope, "vault");
  assert.equal(group.results[0].file, "note.md");
  assert.equal(group.results[0].source, "vault/note.md");
});

test("search rejects invalid UTF-8 without replacing bytes", async () => {
  const root = tmpDir();
  const filePath = path.join(root, "note.md");
  const bytes = Buffer.from([0x23, 0x20, 0x4e, 0x6f, 0x74, 0x65, 0x0a, 0xff, 0x0a]);
  fs.writeFileSync(filePath, bytes);

  await assert.rejects(
    () => searchMarkdownDir(root, "note"),
    (error) => error?.code === "DOTAIOS_EVIDENCE_INVALID_UTF8"
  );
  assert.deepEqual(fs.readFileSync(filePath), bytes);
});

test("search fails closed on the 513th opened source file", async () => {
  const root = tmpDir();
  const context = path.join(root, "context");
  fs.mkdirSync(context);
  for (let index = 0; index < 513; index += 1) {
    fs.writeFileSync(path.join(context, `${String(index).padStart(3, "0")}.md`), `# Note ${index}\n\nneedle\n`);
  }

  await assert.rejects(
    () => searchAios({ aiosPath: root, query: "needle", scope: "context" }),
    (error) => error?.code === "DOTAIOS_EVIDENCE_BUDGET_EXCEEDED"
  );
});

test("search rejects a special eligible file before opening it", {
  skip: process.platform === "win32" ? "mkfifo is unavailable on Windows" : false
}, async () => {
  const root = tmpDir();
  const fifoPath = path.join(root, "blocked.md");
  const { status } = fs.statSync("/bin/sh").isFile()
    ? await import("node:child_process").then(({ spawnSync }) => spawnSync("mkfifo", [fifoPath]))
    : { status: 1 };
  assert.equal(status, 0);

  await assert.rejects(
    () => searchMarkdownDir(root, "needle"),
    (error) => error?.code === "DOTAIOS_EVIDENCE_NOT_REGULAR_FILE"
  );
});

test("project search resolves slug and stable id before constructing only that project's corpus", async () => {
  const root = tmpDir();
  for (const [slug, id, canary] of [
    ["acme-campaign", "project-acme-001", "ACME_PROJECT_SEARCH_CANARY"],
    ["other-client", "project-other-002", "OTHER_PROJECT_SEARCH_CANARY"]
  ]) {
    const projectPath = path.join(root, "projects", slug);
    fs.mkdirSync(projectPath, { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, "README.md"),
      `---\nid: ${id}\nproject: ${slug}\n---\n# ${slug}\n\n${canary} campaign assets\n`
    );
  }

  const search = (projectSelector) => searchAios({
    aiosPath: root,
    query: "campaign assets",
    scope: "projects",
    projectSelector,
    evidenceReader: createEvidenceReader({ roots: [root] })
  });
  const bySlug = await search("acme-campaign");
  const byId = await search("project-acme-001");

  assert.deepEqual(bySlug, byId);
  assert.equal(bySlug.scope.project, "acme-campaign");
  assert.equal(bySlug.scope.projects_omitted, false);
  assert.match(JSON.stringify(bySlug), /ACME_PROJECT_SEARCH_CANARY/);
  assert.doesNotMatch(JSON.stringify(bySlug), /OTHER_PROJECT_SEARCH_CANARY|other-client/);
  await assert.rejects(
    () => searchAios({ aiosPath: root, query: "campaign", scope: "projects" }),
    (error) => error?.code === "DOTAIOS_PROJECT_SELECTOR_INVALID"
  );
});

test("project selection refuses a slug that collides with another project's stable id", async () => {
  const root = tmpDir();
  for (const [slug, id] of [["acme", "project-acme-001"], ["agency", "acme"]]) {
    const projectPath = path.join(root, "projects", slug);
    fs.mkdirSync(projectPath, { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, "README.md"),
      `---\nid: ${id}\nproject: ${slug}\n---\n# ${slug}\n\nCOLLISION_PRIVATE_CANARY\n`,
    );
  }

  await assert.rejects(
    () => searchAios({
      aiosPath: root,
      query: "COLLISION_PRIVATE_CANARY",
      scope: "projects",
      projectSelector: "acme",
    }),
    (error) => error?.code === "DOTAIOS_PROJECT_SELECTOR_AMBIGUOUS",
  );
});

test("direct slug selection skips structurally unselectable neighbor identities", async (t) => {
  for (const kind of ["linked", "oversized"]) {
    await t.test(kind, async () => {
      const root = tmpDir();
      const selectedPath = path.join(root, "projects", "acme-campaign");
      const neighborPath = path.join(root, "projects", "legacy-neighbor");
      fs.mkdirSync(selectedPath, { recursive: true });
      fs.mkdirSync(neighborPath, { recursive: true });
      fs.writeFileSync(
        path.join(selectedPath, "README.md"),
        "---\nid: project-acme-001\nproject: acme-campaign\n---\n# Selected\n\nSELECTED_NEIGHBOR_ISOLATION_CANARY\n",
      );
      const neighborReadme = path.join(neighborPath, "README.md");
      if (kind === "linked") {
        const outside = path.join(root, "outside-neighbor.md");
        fs.writeFileSync(outside, "---\nid: acme-campaign\nproject: legacy-neighbor\n---\n");
        fs.symlinkSync(outside, neighborReadme);
      } else {
        fs.writeFileSync(neighborReadme, "x".repeat((1024 * 1024) + 1));
      }

      const result = await searchAios({
        aiosPath: root,
        query: "SELECTED_NEIGHBOR_ISOLATION_CANARY",
        scope: "projects",
        projectSelector: "acme-campaign",
      });

      assert.equal(result.scope.project, "acme-campaign");
      assert.match(JSON.stringify(result), /SELECTED_NEIGHBOR_ISOLATION_CANARY/);
    });
  }
});

test("project identity isolation preserves strict and state-change failures", async (t) => {
  await t.test("selected linked README remains unsafe", async () => {
    const root = tmpDir();
    const selectedPath = path.join(root, "projects", "acme-campaign");
    fs.mkdirSync(selectedPath, { recursive: true });
    const outside = path.join(root, "outside-selected.md");
    fs.writeFileSync(outside, "---\nid: project-acme-001\nproject: acme-campaign\n---\n");
    fs.symlinkSync(outside, path.join(selectedPath, "README.md"));

    await assert.rejects(
      () => searchAios({
        aiosPath: root,
        query: "campaign",
        scope: "projects",
        projectSelector: "acme-campaign",
      }),
      (error) => error?.code === "DOTAIOS_EVIDENCE_PATH_UNSAFE",
    );
  });

  await t.test("neighbor state change remains fail closed", async () => {
    const root = tmpDir();
    for (const slug of ["acme-campaign", "legacy-neighbor"]) {
      const projectPath = path.join(root, "projects", slug);
      fs.mkdirSync(projectPath, { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, "README.md"),
        `---\nid: project-${slug}\nproject: ${slug}\n---\n# ${slug}\n`,
      );
    }
    const baseReader = createEvidenceReader({ roots: [root] });
    const neighborReadme = path.join(root, "projects", "legacy-neighbor", "README.md");
    const evidenceReader = {
      ...baseReader,
      async readFrontmatter(readerRoot, filePath, options) {
        if (path.resolve(filePath) === path.resolve(neighborReadme)) {
          throw Object.assign(new Error("changed"), { code: "DOTAIOS_EVIDENCE_CHANGED" });
        }
        return baseReader.readFrontmatter(readerRoot, filePath, options);
      },
    };

    await assert.rejects(
      () => searchAios({
        aiosPath: root,
        query: "campaign",
        scope: "projects",
        projectSelector: "acme-campaign",
        evidenceReader,
      }),
      (error) => error?.code === "DOTAIOS_EVIDENCE_CHANGED",
    );
  });
});

test("project identity resolution keeps legacy neighbors non-blocking and header-only", async (t) => {
  await t.test("direct slug scans only bounded neighboring identity headers", async () => {
    const fixture = createLegacyProjectShelf();
    const bodyOnly = path.resolve(fixture.bodyOnlyReadme);
    let bodyReadCalls = 0;
    let bodyBytesRead = 0;
    const filesystem = Object.create(fsp);
    filesystem.open = async (filePath, ...args) => {
      const handle = await fsp.open(filePath, ...args);
      if (path.resolve(String(filePath)) !== bodyOnly) return handle;
      return Object.create(handle, {
        read: { value: async (...readArgs) => {
          const result = await handle.read(...readArgs);
          bodyReadCalls += 1;
          bodyBytesRead += result.bytesRead;
          return result;
        } },
      });
    };
    const result = await searchAios({
      aiosPath: fixture.root,
      query: "SELECTED_LEGACY_SHELF_CANARY",
      scope: "projects",
      projectSelector: "acme-campaign",
      evidenceReader: createEvidenceReader({ roots: [fixture.root], filesystem })
    });
    assert.match(JSON.stringify(result), /SELECTED_LEGACY_SHELF_CANARY/);
    assert.ok(bodyReadCalls <= 2, `body-only README required ${bodyReadCalls} reads`);
    assert.ok(bodyBytesRead <= 5, `body-only README read ${bodyBytesRead} bytes`);
  });

  await t.test("stable id scans only bounded identity headers and skips unselectable records", async () => {
    const fixture = createLegacyProjectShelf();
    const bodyOnly = path.resolve(fixture.bodyOnlyReadme);
    let bodyReadCalls = 0;
    let bodyBytesRead = 0;
    const filesystem = Object.create(fsp);
    filesystem.open = async (filePath, ...args) => {
      const handle = await fsp.open(filePath, ...args);
      if (path.resolve(String(filePath)) !== bodyOnly) return handle;
      return Object.create(handle, {
        read: { value: async (...readArgs) => {
          const result = await handle.read(...readArgs);
          bodyReadCalls += 1;
          bodyBytesRead += result.bytesRead;
          return result;
        } }
      });
    };
    const result = await searchAios({
      aiosPath: fixture.root,
      query: "SELECTED_LEGACY_SHELF_CANARY",
      scope: "projects",
      projectSelector: "project-acme-001",
      evidenceReader: createEvidenceReader({ roots: [fixture.root], filesystem })
    });
    assert.match(JSON.stringify(result), /SELECTED_LEGACY_SHELF_CANARY/);
    assert.ok(bodyReadCalls <= 2, `body-only README required ${bodyReadCalls} reads`);
    assert.ok(bodyBytesRead <= 5, `body-only README read ${bodyBytesRead} bytes`);
  });

  await t.test("stable ids with non-slug punctuation skip direct slug lookup", async () => {
    const root = tmpDir();
    const projectPath = path.join(root, "projects", "acme-campaign");
    fs.mkdirSync(projectPath, { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, "README.md"),
      "---\nid: \"project:acme_001.test\"\nproject: acme-campaign\n---\n# Selected\n\nPUNCTUATED_STABLE_ID_CANARY\n"
    );

    const result = await searchAios({
      aiosPath: root,
      query: "PUNCTUATED_STABLE_ID_CANARY",
      scope: "projects",
      projectSelector: "project:acme_001.test",
      evidenceReader: createEvidenceReader({ roots: [root] })
    });

    assert.equal(result.scope.project, "acme-campaign");
    assert.match(JSON.stringify(result), /PUNCTUATED_STABLE_ID_CANARY/);
  });

  await t.test("stable ids ignore unrelated linked project neighbors", async () => {
    const fixture = createLegacyProjectShelf();
    const outside = tmpDir();
    fs.symlinkSync(outside, path.join(fixture.root, "projects", "legacy-linked"));

    const result = await searchAios({
      aiosPath: fixture.root,
      query: "SELECTED_LEGACY_SHELF_CANARY",
      scope: "projects",
      projectSelector: "project-acme-001",
      evidenceReader: createEvidenceReader({ roots: [fixture.root] })
    });

    assert.equal(result.scope.project, "acme-campaign");
    assert.match(JSON.stringify(result), /SELECTED_LEGACY_SHELF_CANARY/);
  });
});

test("all-scope search without a project selector omits the project corpus and reports it", async () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, "context"), { recursive: true });
  fs.mkdirSync(path.join(root, "projects", "private-client"), { recursive: true });
  fs.writeFileSync(path.join(root, "context", "work.md"), "# Work\n\nSHARED_SEARCH_CANARY\n");
  fs.writeFileSync(
    path.join(root, "projects", "private-client", "README.md"),
    "---\nid: private-client-id\nproject: private-client\n---\n# Private\n\nPRIVATE_PROJECT_CANARY\n"
  );

  const groups = await searchAios({ aiosPath: root, query: "CANARY", scope: "all" });

  assert.equal(groups.scope.project, null);
  assert.equal(groups.scope.projects_omitted, true);
  assert.equal(groups.some((group) => group.scope === "projects"), false);
  assert.doesNotMatch(JSON.stringify(groups), /PRIVATE_PROJECT_CANARY/);
});

function createLegacyProjectShelf() {
  const root = tmpDir();
  const projects = path.join(root, "projects");
  const selected = path.join(projects, "acme-campaign");
  const bodyOnly = path.join(projects, "legacy-body-only");
  const missingId = path.join(projects, "legacy-missing-id");
  const malformed = path.join(projects, "legacy-malformed");
  for (const directory of [selected, bodyOnly, missingId, malformed]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(
    path.join(selected, "README.md"),
    "---\nid: project-acme-001\nproject: acme-campaign\n---\n# Selected\n\nSELECTED_LEGACY_SHELF_CANARY\n"
  );
  fs.writeFileSync(path.join(bodyOnly, "README.md"), `# Legacy\n\n${"body ".repeat(8_000)}`);
  fs.writeFileSync(
    path.join(missingId, "README.md"),
    "---\nproject: legacy-missing-id\n---\n# Missing stable identity\n\nLEGACY_BODY_CANARY\n"
  );
  fs.writeFileSync(
    path.join(malformed, "README.md"),
    "---\nid: [unterminated\n---\n# Malformed\n\nMALFORMED_BODY_CANARY\n"
  );
  return {
    root,
    bodyOnlyReadme: path.join(bodyOnly, "README.md"),
    legacyReadmes: [bodyOnly, missingId, malformed].map((directory) => path.join(directory, "README.md"))
  };
}
