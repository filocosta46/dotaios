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

test("search ranks inside the corpus transaction and publishes only after final validation", async () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, "b-body.md"), "# Body\n\nTRANSACTION_SEARCH_CANARY\n");
  fs.writeFileSync(path.join(root, "a-heading.md"), "# TRANSACTION_SEARCH_CANARY\n\nPlain body.\n");
  const baseReader = createEvidenceReader({ roots: [root] });
  let transactionCalls = 0;
  let callbackResult;
  let releaseFinalValidation;
  const finalValidationGate = new Promise((resolve) => {
    releaseFinalValidation = resolve;
  });
  let reportCallbackComplete;
  const callbackComplete = new Promise((resolve) => {
    reportCallbackComplete = resolve;
  });
  const reader = {
    ...baseReader,
    async withTextCorpus(transactionRoot, directoryPath, options, callback) {
      transactionCalls += 1;
      return baseReader.withTextCorpus(transactionRoot, directoryPath, options, async (transaction) => {
        callbackResult = await callback(transaction);
        reportCallbackComplete();
        await finalValidationGate;
        return callbackResult;
      });
    }
  };

  const pending = searchMarkdownDir(root, "TRANSACTION_SEARCH_CANARY", { reader, root });
  const firstCompleted = await Promise.race([
    callbackComplete.then(() => "callback"),
    pending.then(() => "search")
  ]);

  assert.equal(firstCompleted, "callback", "ranking must complete inside the transaction callback");
  assert.deepEqual(callbackResult.map(({ file }) => file), ["a-heading.md", "b-body.md"]);
  let published = false;
  pending.then(() => {
    published = true;
  });
  await Promise.resolve();
  assert.equal(published, false, "callback results must remain private until final validation completes");

  releaseFinalValidation();
  const results = await pending;

  assert.deepEqual(results, callbackResult);
  assert.equal(transactionCalls, 1);
});

test("search rejects ranked results when final corpus validation observes a changed generation", async () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, "note.md"), "# Existing\n\nFINAL_VALIDATION_CANARY\n");
  const baseReader = createEvidenceReader({ roots: [root] });
  let rankedInsideCallback = null;
  const reader = {
    ...baseReader,
    withTextCorpus(transactionRoot, directoryPath, options, callback) {
      return baseReader.withTextCorpus(transactionRoot, directoryPath, options, async (transaction) => {
        rankedInsideCallback = await callback(transaction);
        fs.writeFileSync(path.join(root, "late.md"), "# Late generation\n");
        return rankedInsideCallback;
      });
    }
  };

  await assert.rejects(
    () => searchMarkdownDir(root, "FINAL_VALIDATION_CANARY", { reader, root }),
    (error) => error?.code === "DOTAIOS_EVIDENCE_CHANGED"
  );
  assert.deepEqual(rankedInsideCallback.map(({ file }) => file), ["note.md"]);
});

test("request-scoped search observes added, modified, and deleted files on the next request", async () => {
  const root = tmpDir();
  const firstPath = path.join(root, "first.md");
  const secondPath = path.join(root, "second.md");
  fs.writeFileSync(firstPath, "# First\n\nNEXT_REQUEST_CANARY\n");
  const reader = createEvidenceReader({ roots: [root] });
  const search = () => searchMarkdownDir(root, "NEXT_REQUEST_CANARY", { reader, root });

  assert.deepEqual((await search()).map(({ file }) => file), ["first.md"]);
  fs.writeFileSync(secondPath, "# Second\n\nNEXT_REQUEST_CANARY\n");
  assert.deepEqual((await search()).map(({ file }) => file), ["first.md", "second.md"]);
  fs.writeFileSync(firstPath, "# First\n\nChanged content.\n");
  assert.deepEqual((await search()).map(({ file }) => file), ["second.md"]);
  fs.unlinkSync(secondPath);
  assert.deepEqual(await search(), []);
});

// This asserted the budget by its number — "the 513th file" — so it passed only
// while the default was the bounded projection's 512, which made every search on
// a real folder fail closed. The property worth keeping is that an exhausted
// budget still refuses rather than quietly returning a partial corpus; the
// number it happens to be set to is not that property. The default's real size
// is covered in tests/core/search_corpus_scale.test.mjs.
test("scope search reports its whole corpus omitted when its read budget is exhausted", async () => {
  const root = tmpDir();
  const context = path.join(root, "context");
  fs.mkdirSync(context);
  for (let index = 0; index < 8; index += 1) {
    fs.writeFileSync(path.join(context, `${String(index).padStart(3, "0")}.md`), `# Note ${index}\n\nneedle\n`);
  }
  const reader = createEvidenceReader({
    roots: [root],
    limits: { maxBytes: 4096, maxFiles: 2, maxEntries: 4, maxFileBytes: 4096 }
  });

  const groups = await searchAios({ aiosPath: root, query: "needle", scope: "context", evidenceReader: reader });

  assert.deepEqual([...groups], []);
  assert.equal(groups.omissions.length, 1);
  assert.equal(groups.omissions[0].scope, "context");
  assert.ok(["file_count_exceeded", "entry_count_exceeded"].includes(groups.omissions[0].reason));
});

test("all-scope search returns unaffected results with a frozen path-free ceiling omission", async () => {
  const parent = tmpDir();
  const root = path.join(parent, "aios");
  const vault = path.join(parent, "vault");
  fs.mkdirSync(path.join(root, "context"), { recursive: true });
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(root, "context", "safe.md"), "# Safe\n\nSAFE_PARTIAL_SEARCH_CANARY\n");
  fs.writeFileSync(path.join(vault, "oversized.md"), "x".repeat(65));
  const reader = createEvidenceReader({
    roots: [root, vault],
    limits: { maxBytes: 1024, maxFiles: 100, maxEntries: 100, maxFileBytes: 64, maxDirectoryEntries: 100 }
  });

  const groups = await searchAios({
    aiosPath: root,
    vaultPath: vault,
    query: "SAFE_PARTIAL_SEARCH_CANARY",
    scope: "all",
    evidenceReader: reader
  });

  assert.match(JSON.stringify(groups), /SAFE_PARTIAL_SEARCH_CANARY/);
  assert.deepEqual(groups.omissions, [{
    scope: "vault",
    reason: "file_too_large",
    observed: { files: 0, bytes: 0, entries: 1 },
    inspection: "not_searched",
    recovery: {
      code: "split_or_move_file",
      message: "Split the oversized file, or move it outside this search scope."
    }
  }]);
  assert.equal(Object.isFrozen(groups.omissions), true);
  assert.equal(Object.isFrozen(groups.omissions[0]), true);
  assert.equal(Object.isFrozen(groups.omissions[0].observed), true);
  assert.equal(Object.isFrozen(groups.omissions[0].recovery), true);
  assert.doesNotMatch(JSON.stringify(groups.omissions), new RegExp(parent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("scope search distinguishes every skippable ceiling without catching integrity failures", async (t) => {
  const cases = [
    {
      name: "directory entries",
      reason: "directory_entries_exceeded",
      limits: { maxBytes: 1024, maxFiles: 10, maxEntries: 10, maxFileBytes: 1024, maxDirectoryEntries: 1 },
      files: [["one.md", "one\n"], ["two.md", "two\n"]]
    },
    {
      name: "aggregate bytes",
      reason: "aggregate_bytes_exceeded",
      limits: { maxBytes: 7, maxFiles: 10, maxEntries: 10, maxFileBytes: 10, maxDirectoryEntries: 10 },
      files: [["one.md", "one\n"], ["two.md", "two\n"]]
    },
    {
      name: "file count",
      reason: "file_count_exceeded",
      limits: { maxBytes: 1024, maxFiles: 1, maxEntries: 10, maxFileBytes: 1024, maxDirectoryEntries: 10 },
      files: [["one.md", "one\n"], ["two.md", "two\n"]]
    },
    {
      name: "entry count",
      reason: "entry_count_exceeded",
      limits: { maxBytes: 1024, maxFiles: 10, maxEntries: 1, maxFileBytes: 1024, maxDirectoryEntries: 10 },
      files: [["one.md", "one\n"], ["two.md", "two\n"]]
    }
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = tmpDir();
      const context = path.join(root, "context");
      fs.mkdirSync(context);
      for (const [name, content] of fixture.files) fs.writeFileSync(path.join(context, name), content);
      const groups = await searchAios({
        aiosPath: root,
        query: "missing",
        scope: "context",
        evidenceReader: createEvidenceReader({ roots: [root], limits: fixture.limits })
      });

      assert.deepEqual([...groups], []);
      assert.equal(groups.omissions[0].reason, fixture.reason);
      assert.equal(
        groups.omissions[0].inspection,
        fixture.reason === "directory_entries_exceeded" ? "partially_enumerated" : "not_searched"
      );
    });
  }
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

test("project search preserves the exact raw project selector", async () => {
  const root = tmpDir();
  const projectPath = path.join(root, "projects", "acme-campaign");
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, "README.md"),
    "---\nid: project-acme-001\nproject: acme-campaign\n---\n# Acme\n\nRAW_SELECTOR_CORE_CANARY\n",
  );

  const exact = await searchAios({
    aiosPath: root,
    query: "RAW_SELECTOR_CORE_CANARY",
    scope: "projects",
    projectSelector: "acme-campaign",
  });
  assert.match(JSON.stringify(exact), /RAW_SELECTOR_CORE_CANARY/);

  await assert.rejects(
    () => searchAios({
      aiosPath: root,
      query: "RAW_SELECTOR_CORE_CANARY",
      scope: "projects",
      projectSelector: " acme-campaign ",
    }),
    (error) => error?.code === "DOTAIOS_PROJECT_SELECTOR_INVALID",
  );
});

test("project search refuses catalog identities outside the selector contract", async (t) => {
  for (const id of ["project acme 001", "project/acme", " project-acme-001 ", "x".repeat(201)]) {
    await t.test(`stable id ${JSON.stringify(id.slice(0, 24))}`, async () => {
      const root = tmpDir();
      const projectPath = path.join(root, "projects", "acme-campaign");
      fs.mkdirSync(projectPath, { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, "README.md"),
        `---\nid: ${JSON.stringify(id)}\nproject: acme-campaign\n---\n# Selected\n\nINVALID_ID_PRIVATE_CANARY\n`,
      );

      await assert.rejects(
        () => searchAios({
          aiosPath: root,
          query: "INVALID_ID_PRIVATE_CANARY",
          scope: "projects",
          projectSelector: "acme-campaign",
        }),
        (error) => error?.code === "DOTAIOS_PROJECT_CATALOG_INVALID",
      );
      await assert.rejects(
        () => searchAios({
          aiosPath: root,
          query: "INVALID_ID_PRIVATE_CANARY",
          scope: "projects",
          projectSelector: id,
        }),
        (error) => error?.code === "DOTAIOS_PROJECT_SELECTOR_INVALID",
      );
    });
  }

  await t.test("201-code-point slug", async () => {
    const root = tmpDir();
    const slug = "s".repeat(201);
    const projectPath = path.join(root, "projects", slug);
    fs.mkdirSync(projectPath, { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, "README.md"),
      `---\nid: project-long-slug\nproject: ${slug}\n---\n# Selected\n`,
    );

    await assert.rejects(
      () => searchAios({
        aiosPath: root,
        query: "Selected",
        scope: "projects",
        projectSelector: "project-long-slug",
      }),
      (error) => error?.code === "DOTAIOS_PROJECT_SELECTOR_UNKNOWN",
    );
    await assert.rejects(
      () => searchAios({
        aiosPath: root,
        query: "Selected",
        scope: "projects",
        projectSelector: slug,
      }),
      (error) => error?.code === "DOTAIOS_PROJECT_SELECTOR_INVALID",
    );
  });

  await t.test("padded neighboring stable id", async () => {
    const root = tmpDir();
    for (const [slug, id, canary] of [
      ["acme-campaign", "project-acme-001", "SELECTED_VALID_ID_CANARY"],
      ["legacy-neighbor", " acme-campaign ", "PADDED_NEIGHBOR_PRIVATE_CANARY"],
    ]) {
      const projectPath = path.join(root, "projects", slug);
      fs.mkdirSync(projectPath, { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, "README.md"),
        `---\nid: ${JSON.stringify(id)}\nproject: ${slug}\n---\n# ${slug}\n\n${canary}\n`,
      );
    }

    const result = await searchAios({
      aiosPath: root,
      query: "SELECTED_VALID_ID_CANARY",
      scope: "projects",
      projectSelector: "acme-campaign",
    });

    assert.equal(result.scope.project, "acme-campaign");
    assert.match(JSON.stringify(result), /SELECTED_VALID_ID_CANARY/);
    assert.doesNotMatch(JSON.stringify(result), /PADDED_NEIGHBOR_PRIVATE_CANARY|legacy-neighbor/);
  });

  await t.test("conflicting canonical and legacy ids", async () => {
    const root = tmpDir();
    const projectPath = path.join(root, "projects", "acme-campaign");
    fs.mkdirSync(projectPath, { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, "README.md"),
      "---\nid: project-acme-001\nproject_id: conflicting-id\nproject: acme-campaign\n---\n# Selected\n",
    );

    await assert.rejects(
      () => searchAios({
        aiosPath: root,
        query: "Selected",
        scope: "projects",
        projectSelector: "acme-campaign",
      }),
      (error) => error?.code === "DOTAIOS_PROJECT_CATALOG_INVALID",
    );
  });

  await t.test("conflicting neighboring ids remain unselectable", async () => {
    const root = tmpDir();
    for (const [slug, frontmatter, canary] of [
      ["acme-campaign", "id: project-acme-001", "SELECTED_CONFLICT_ISOLATION_CANARY"],
      ["legacy-neighbor", "id: acme-campaign\nproject_id: conflicting-id", "CONFLICTING_NEIGHBOR_PRIVATE_CANARY"],
    ]) {
      const projectPath = path.join(root, "projects", slug);
      fs.mkdirSync(projectPath, { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, "README.md"),
        `---\n${frontmatter}\nproject: ${slug}\n---\n# ${slug}\n\n${canary}\n`,
      );
    }

    const result = await searchAios({
      aiosPath: root,
      query: "SELECTED_CONFLICT_ISOLATION_CANARY",
      scope: "projects",
      projectSelector: "acme-campaign",
    });

    assert.equal(result.scope.project, "acme-campaign");
    assert.match(JSON.stringify(result), /SELECTED_CONFLICT_ISOLATION_CANARY/);
    assert.doesNotMatch(JSON.stringify(result), /CONFLICTING_NEIGHBOR_PRIVATE_CANARY|legacy-neighbor/);
  });

  await t.test("matching canonical and legacy ids remain selectable", async () => {
    const root = tmpDir();
    const projectPath = path.join(root, "projects", "acme-campaign");
    fs.mkdirSync(projectPath, { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, "README.md"),
      "---\nid: project-acme-001\nproject_id: project-acme-001\nproject: acme-campaign\n---\n# Selected\n\nMATCHING_DUAL_ID_CANARY\n",
    );

    const bySlug = await searchAios({
      aiosPath: root,
      query: "MATCHING_DUAL_ID_CANARY",
      scope: "projects",
      projectSelector: "acme-campaign",
    });
    const byId = await searchAios({
      aiosPath: root,
      query: "MATCHING_DUAL_ID_CANARY",
      scope: "projects",
      projectSelector: "project-acme-001",
    });

    assert.deepEqual(bySlug, byId);
  });

  for (const fields of [
    "id: 123\nproject_id: project-acme-001",
    "id: \"\"\nproject_id: project-acme-001",
    "id: project-acme-001\nproject_id: 123",
    "id: project-acme-001\nproject_id: \"\"",
  ]) {
    await t.test(`present malformed alias ${JSON.stringify(fields)}`, async () => {
      const root = tmpDir();
      const projectPath = path.join(root, "projects", "acme-campaign");
      fs.mkdirSync(projectPath, { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, "README.md"),
        `---\n${fields}\nproject: acme-campaign\n---\n# Selected\n`,
      );

      await assert.rejects(
        () => searchAios({
          aiosPath: root,
          query: "Selected",
          scope: "projects",
          projectSelector: "acme-campaign",
        }),
        (error) => error?.code === "DOTAIOS_PROJECT_CATALOG_INVALID",
      );
    });
  }

  await t.test("malformed canonical neighbor remains unselectable", async () => {
    const root = tmpDir();
    for (const [slug, fields, canary] of [
      ["acme-campaign", "id: project-acme-001", "SELECTED_MALFORMED_ALIAS_CANARY"],
      ["legacy-neighbor", "id: 123\nproject_id: acme-campaign", "MALFORMED_ALIAS_PRIVATE_CANARY"],
    ]) {
      const projectPath = path.join(root, "projects", slug);
      fs.mkdirSync(projectPath, { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, "README.md"),
        `---\n${fields}\nproject: ${slug}\n---\n# ${slug}\n\n${canary}\n`,
      );
    }

    const result = await searchAios({
      aiosPath: root,
      query: "SELECTED_MALFORMED_ALIAS_CANARY",
      scope: "projects",
      projectSelector: "acme-campaign",
    });

    assert.equal(result.scope.project, "acme-campaign");
    assert.doesNotMatch(JSON.stringify(result), /MALFORMED_ALIAS_PRIVATE_CANARY|legacy-neighbor/);
  });

  await t.test("legacy-only stable id remains selectable", async () => {
    const root = tmpDir();
    const projectPath = path.join(root, "projects", "acme-campaign");
    fs.mkdirSync(projectPath, { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, "README.md"),
      "---\nproject_id: project-acme-001\nproject: acme-campaign\n---\n# Selected\n\nLEGACY_ONLY_ID_CANARY\n",
    );

    const bySlug = await searchAios({
      aiosPath: root,
      query: "LEGACY_ONLY_ID_CANARY",
      scope: "projects",
      projectSelector: "acme-campaign",
    });
    const byId = await searchAios({
      aiosPath: root,
      query: "LEGACY_ONLY_ID_CANARY",
      scope: "projects",
      projectSelector: "project-acme-001",
    });

    assert.deepEqual(bySlug, byId);
  });

  for (const metadata of ["", "null", "[]", "123", "scalar"]) {
    await t.test(`non-mapping metadata ${JSON.stringify(metadata)}`, async () => {
      const root = tmpDir();
      const projectPath = path.join(root, "projects", "acme-campaign");
      fs.mkdirSync(projectPath, { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, "README.md"),
        `---\n${metadata}\n---\n# Selected\n`,
      );

      await assert.rejects(
        () => searchAios({
          aiosPath: root,
          query: "Selected",
          scope: "projects",
          projectSelector: "acme-campaign",
        }),
        (error) => error?.code === "DOTAIOS_PROJECT_CATALOG_INVALID",
      );
    });
  }

  await t.test("non-mapping neighboring metadata remains unselectable", async () => {
    const root = tmpDir();
    for (const [slug, frontmatter, canary] of [
      ["acme-campaign", "id: project-acme-001\nproject: acme-campaign", "SELECTED_MAPPING_CANARY"],
      ["legacy-neighbor", "null", "NON_MAPPING_PRIVATE_CANARY"],
    ]) {
      const projectPath = path.join(root, "projects", slug);
      fs.mkdirSync(projectPath, { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, "README.md"),
        `---\n${frontmatter}\n---\n# ${slug}\n\n${canary}\n`,
      );
    }

    const result = await searchAios({
      aiosPath: root,
      query: "SELECTED_MAPPING_CANARY",
      scope: "projects",
      projectSelector: "acme-campaign",
    });

    assert.equal(result.scope.project, "acme-campaign");
    assert.doesNotMatch(JSON.stringify(result), /NON_MAPPING_PRIVATE_CANARY|legacy-neighbor/);
  });
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
  for (const kind of ["missing", "linked", "special", "oversized"]) {
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
      } else if (kind === "special") {
        fs.mkdirSync(neighborReadme);
      } else if (kind === "oversized") {
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

test("project selection fails closed when a readable collision becomes linked", async () => {
  const root = tmpDir();
  const selectedPath = path.join(root, "projects", "acme-campaign");
  const neighborPath = path.join(root, "projects", "legacy-neighbor");
  fs.mkdirSync(selectedPath, { recursive: true });
  fs.mkdirSync(neighborPath, { recursive: true });
  fs.writeFileSync(
    path.join(selectedPath, "README.md"),
    "---\nid: project-acme-001\nproject: acme-campaign\n---\n# Selected\n\nSELECTED_REPLACEMENT_CANARY\n",
  );
  const neighborReadme = path.join(neighborPath, "README.md");
  const outside = path.join(root, "outside-neighbor.md");
  fs.writeFileSync(
    neighborReadme,
    "---\nid: acme-campaign\nproject: legacy-neighbor\n---\n# Readable collision\n",
  );
  fs.writeFileSync(outside, "---\nid: unrelated\nproject: outside\n---\n");
  const replacement = replaceOnNeighborFrontmatter(
    createEvidenceReader({ roots: [root] }), neighborReadme, outside,
  );

  await assert.rejects(
    () => searchAios({
      aiosPath: root,
      query: "SELECTED_REPLACEMENT_CANARY",
      scope: "projects",
      projectSelector: "acme-campaign",
      evidenceReader: replacement.reader,
    }),
    (error) => {
      assert.equal(replacement.didReplace(), true);
      return error?.code === "DOTAIOS_EVIDENCE_CHANGED";
    },
  );
  assert.equal(replacement.didReplace(), true);
});

test("project selection fails closed when a missing identity becomes a readable collision", async () => {
  const root = tmpDir();
  const selectedPath = path.join(root, "projects", "acme-campaign");
  const neighborPath = path.join(root, "projects", "legacy-neighbor");
  fs.mkdirSync(selectedPath, { recursive: true });
  fs.mkdirSync(neighborPath, { recursive: true });
  fs.writeFileSync(
    path.join(selectedPath, "README.md"),
    "---\nid: project-acme-001\nproject: acme-campaign\n---\n# Selected\n\nSELECTED_INSERTION_CANARY\n",
  );
  const neighborReadme = path.join(neighborPath, "README.md");
  const insertion = insertCollisionAfterMissingInspection(
    createEvidenceReader({ roots: [root] }), neighborReadme,
  );

  await assert.rejects(
    () => searchAios({
      aiosPath: root,
      query: "SELECTED_INSERTION_CANARY",
      scope: "projects",
      projectSelector: "acme-campaign",
      evidenceReader: insertion.reader,
    }),
    (error) => {
      assert.equal(insertion.didInsert(), true);
      return error?.code === "DOTAIOS_EVIDENCE_CHANGED";
    },
  );
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

function replaceOnNeighborFrontmatter(evidenceReader, targetPath, linkTarget) {
  let replaced = false;
  const reader = {
    ...evidenceReader,
    async readFrontmatter(root, filePath, options) {
      if (!replaced && path.resolve(String(filePath)) === path.resolve(targetPath)) {
        fs.rmSync(targetPath);
        fs.symlinkSync(linkTarget, targetPath);
        replaced = true;
      }
      return evidenceReader.readFrontmatter(root, filePath, options);
    },
  };
  return Object.freeze({ reader: Object.freeze(reader), didReplace: () => replaced });
}

function insertCollisionAfterMissingInspection(evidenceReader, targetPath) {
  let inserted = false;
  const reader = {
    ...evidenceReader,
    async inspectEntry(root, filePath, options) {
      const entry = await evidenceReader.inspectEntry(root, filePath, options);
      if (!inserted && entry === null && path.resolve(String(filePath)) === path.resolve(targetPath)) {
        fs.writeFileSync(
          targetPath,
          "---\nid: acme-campaign\nproject: legacy-neighbor\n---\n# Inserted collision\n",
        );
        inserted = true;
      }
      return entry;
    },
  };
  return Object.freeze({ reader: Object.freeze(reader), didInsert: () => inserted });
}
