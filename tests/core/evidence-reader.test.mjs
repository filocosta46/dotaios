import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createEvidenceReader } from "../../packages/core/src/evidence-reader.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-evidence-reader-"));
}

test("evidence reader lists one directory deterministically without traversing it", async () => {
  const root = tmpDir();
  const dir = path.join(root, "skills");
  fs.mkdirSync(path.join(dir, "zeta"), { recursive: true });
  fs.mkdirSync(path.join(dir, "alpha"), { recursive: true });

  const reader = createEvidenceReader({ roots: [root] });
  const entries = await reader.listDirectory(root, dir);

  assert.deepEqual(entries.map((entry) => entry.name), ["alpha", "zeta"]);
  assert.deepEqual(reader.snapshot(), { bytes: 0, files: 0, entries: 2 });
});

test("evidence frontmatter reads reserve declared bytes but return only metadata", async () => {
  const root = tmpDir();
  const filePath = path.join(root, "SKILL.md");
  fs.writeFileSync(filePath, `---\nname: bounded\ndescription: Prefix only.\n---\n${"body ".repeat(30_000)}`);

  const reader = createEvidenceReader({
    roots: [root],
    limits: { maxBytes: 256 * 1024, maxFiles: 1, maxEntries: 1, maxFileBytes: 256 * 1024 }
  });
  const prefix = await reader.readFrontmatter(root, filePath, { maxBytes: 4096 });

  assert.ok(Buffer.byteLength(prefix, "utf8") < 100);
  assert.match(prefix, /name: bounded/);
  assert.deepEqual(reader.snapshot(), { bytes: fs.statSync(filePath).size, files: 1, entries: 0 });
});

test("evidence frontmatter rejects a delimiter beyond the bounded prefix", async () => {
  const root = tmpDir();
  const filePath = path.join(root, "SKILL.md");
  const original = `---\nname: bounded\ndescription: ${"x".repeat(70 * 1024)}\n---\n`;
  fs.writeFileSync(filePath, original);
  const reader = createEvidenceReader({
    roots: [root],
    limits: { maxBytes: 128 * 1024, maxFiles: 1, maxEntries: 1, maxFileBytes: 128 * 1024 }
  });

  await assert.rejects(
    () => reader.readFrontmatter(root, filePath, { maxBytes: 64 * 1024 }),
    (error) => error?.code === "DOTAIOS_EVIDENCE_FRONTMATTER_INVALID"
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), original);
});

test("evidence reader enforces one aggregate byte budget across sources", async () => {
  const root = tmpDir();
  const first = path.join(root, "first.md");
  const second = path.join(root, "second.md");
  fs.writeFileSync(first, "first\n");
  fs.writeFileSync(second, "other\n");
  const reader = createEvidenceReader({
    roots: [root],
    limits: { maxBytes: 10, maxFiles: 2, maxEntries: 2, maxFileBytes: 10 }
  });

  assert.equal(await reader.readText(root, first), "first\n");
  await assert.rejects(
    () => reader.readText(root, second),
    (error) => error?.code === "DOTAIOS_EVIDENCE_BUDGET_EXCEEDED"
  );
});

test("evidence reader enforces one aggregate directory-entry budget", async () => {
  const root = tmpDir();
  for (const name of ["alpha", "beta", "gamma"]) fs.writeFileSync(path.join(root, name), name);
  const reader = createEvidenceReader({
    roots: [root],
    limits: { maxBytes: 100, maxFiles: 3, maxEntries: 2, maxDirectoryEntries: 10 }
  });

  await assert.rejects(
    () => reader.listDirectory(root, root),
    (error) => error?.code === "DOTAIOS_EVIDENCE_BUDGET_EXCEEDED"
  );
});

test("evidence reader charges every JSONL record to the aggregate entry budget", async () => {
  const root = tmpDir();
  const filePath = path.join(root, "events.jsonl");
  fs.writeFileSync(filePath, '{"id":1}\n{not-json}\n{"id":2}\n');
  const reader = createEvidenceReader({
    roots: [root],
    limits: { maxBytes: 100, maxFiles: 1, maxEntries: 2, maxFileBytes: 100 }
  });

  await assert.rejects(
    () => reader.readJsonl(root, filePath),
    (error) => error?.code === "DOTAIOS_EVIDENCE_BUDGET_EXCEEDED"
  );
});

test("evidence reader rejects an atomic source replacement before reading bytes", async () => {
  const root = tmpDir();
  const source = path.join(root, "source.md");
  const parked = path.join(root, "source.parked.md");
  const original = "# Original\n\nINSIDE_CANARY\n";
  fs.writeFileSync(source, original);
  let replaced = false;
  const filesystem = new Proxy(fsp, {
    get(target, property) {
      if (property === "open") {
        return async (candidate, flags) => {
          if (candidate !== source || replaced) return fsp.open(candidate, flags);
          replaced = true;
          await fsp.rename(source, parked);
          await fsp.writeFile(source, "# Replacement\n\nOUTSIDE_CANARY\n");
          return fsp.open(source, flags);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const reader = createEvidenceReader({ roots: [root], filesystem });

  try {
    await assert.rejects(
      () => reader.readText(root, source),
      (error) => replaced && error?.code === "DOTAIOS_EVIDENCE_CHANGED"
    );
  } finally {
    fs.rmSync(source, { force: true });
    fs.renameSync(parked, source);
  }
  assert.equal(fs.readFileSync(source, "utf8"), original);
});

test("evidence reader rejects a real directory replacement after enumeration", async () => {
  const root = tmpDir();
  const corpus = path.join(root, "context");
  const parked = path.join(root, "context-parked");
  const source = path.join(corpus, "note.md");
  fs.mkdirSync(corpus);
  fs.writeFileSync(source, "# Original\n\nINSIDE_CANARY\n");
  const reader = createEvidenceReader({ roots: [root] });
  const [listed] = await reader.listFiles(root, corpus, { extensions: [".md"] });

  fs.renameSync(corpus, parked);
  fs.mkdirSync(corpus);
  fs.writeFileSync(source, "# Replacement\n\nREPLACEMENT_CANARY\n");

  await assert.rejects(
    () => reader.readText(root, listed),
    (error) => error?.code === "DOTAIOS_EVIDENCE_CHANGED"
  );
});

test("evidence reader maps a shallow and nested text corpus inside one validated transaction", async () => {
  const root = tmpDir();
  const corpus = path.join(root, "vault");
  const nested = path.join(corpus, "nested");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(corpus, "alpha.md"), "# Alpha\n\nALPHA_CANARY\n");
  fs.writeFileSync(path.join(nested, "beta.md"), "# Beta\n\nBETA_CANARY\n");
  fs.writeFileSync(path.join(nested, "ignored.txt"), "IGNORED_CANARY\n");
  const reader = createEvidenceReader({ roots: [root] });

  const observed = await reader.withTextCorpus(
    root,
    corpus,
    { extensions: [".md"] },
    (transaction) => transaction.mapFiles(({ filePath, content }) => ({ filePath, content }))
  );

  assert.deepEqual(observed, [
    { filePath: path.join(corpus, "alpha.md"), content: "# Alpha\n\nALPHA_CANARY\n" },
    { filePath: path.join(nested, "beta.md"), content: "# Beta\n\nBETA_CANARY\n" }
  ]);
});

test("evidence corpus transactions revalidate the authorized root even when the corpus is missing", async () => {
  const parent = tmpDir();
  const root = path.join(parent, "authorized");
  const parked = path.join(parent, "authorized-parked");
  fs.mkdirSync(root);
  const reader = createEvidenceReader({ roots: [root] });

  await assert.rejects(
    () => reader.withTextCorpus(
      root,
      path.join(root, "missing"),
      { extensions: [".md"] },
      async (transaction) => {
        assert.deepEqual(await transaction.mapFiles(({ content }) => content), []);
        fs.renameSync(root, parked);
        fs.mkdirSync(root);
        return "must not escape";
      }
    ),
    (error) => error?.code === "DOTAIOS_EVIDENCE_CHANGED"
  );
});

test("evidence corpus transactions revalidate the nearest observed ancestor of a nested missing corpus", async () => {
  const root = tmpDir();
  const existing = path.join(root, "existing");
  const missing = path.join(existing, "future", "corpus");
  fs.mkdirSync(existing);
  const reader = createEvidenceReader({ roots: [root] });

  await assert.rejects(
    () => reader.withTextCorpus(
      root,
      missing,
      { extensions: [".md"] },
      async (transaction) => {
        assert.deepEqual(await transaction.mapFiles(({ content }) => content), []);
        fs.mkdirSync(missing, { recursive: true });
        fs.writeFileSync(path.join(missing, "inserted.md"), "# Inserted\n");
        return "must not escape";
      }
    ),
    (error) => error?.code === "DOTAIOS_EVIDENCE_CHANGED"
  );
});

test("evidence corpus transactions support an external authorized root and selector predicate", async () => {
  const parent = tmpDir();
  const aiosRoot = path.join(parent, "aios");
  const externalRoot = path.join(parent, "external-vault");
  fs.mkdirSync(aiosRoot);
  fs.mkdirSync(path.join(externalRoot, "plugin"), { recursive: true });
  fs.writeFileSync(path.join(externalRoot, "plugin", "manifest.json"), '{"name":"selected"}\n');
  fs.writeFileSync(path.join(externalRoot, "plugin", "private.json"), '{"name":"private"}\n');
  fs.writeFileSync(path.join(externalRoot, "note.md"), "# Not selected\n");
  const reader = createEvidenceReader({ roots: [aiosRoot, externalRoot] });

  const observed = await reader.withTextCorpus(
    externalRoot,
    externalRoot,
    { includeFile: (filePath) => path.basename(filePath) === "manifest.json" },
    (transaction) => transaction.mapFiles((file) => file)
  );

  assert.deepEqual(observed, [{
    filePath: path.join(externalRoot, "plugin", "manifest.json"),
    content: '{"name":"selected"}\n',
    mtimeMs: fs.statSync(path.join(externalRoot, "plugin", "manifest.json")).mtimeMs
  }]);
});

test("evidence corpus transactions preserve ordinary contained-read semantics for in-root hard links", async () => {
  const root = tmpDir();
  const original = path.join(root, "original.txt");
  const linked = path.join(root, "linked.md");
  fs.writeFileSync(original, "# Shared inode\n\nHARD_LINK_CANARY\n");
  fs.linkSync(original, linked);
  const ordinaryReader = createEvidenceReader({ roots: [root] });
  const expected = await ordinaryReader.readText(root, linked);
  const transactionReader = createEvidenceReader({ roots: [root] });

  const observed = await transactionReader.withTextCorpus(
    root,
    root,
    { extensions: [".md"] },
    (transaction) => transaction.mapFiles(({ filePath, content }) => ({ filePath, content }))
  );

  assert.deepEqual(observed, [{ filePath: linked, content: expected }]);
});

test("evidence corpus transaction capabilities close before successful results escape", async () => {
  const root = tmpDir();
  const source = path.join(root, "note.md");
  fs.writeFileSync(source, "# Note\n");
  let finalValidationArmed = false;
  let releaseValidation;
  let validationEntered;
  const entered = new Promise((resolve) => { validationEntered = resolve; });
  const released = new Promise((resolve) => { releaseValidation = resolve; });
  const filesystem = Object.create(fsp);
  filesystem.lstat = async (targetPath, options) => {
    if (
      finalValidationArmed
      && path.resolve(String(targetPath)) === path.resolve(root)
      && options?.bigint === true
    ) {
      finalValidationArmed = false;
      validationEntered();
      await released;
    }
    return fsp.lstat(targetPath, options);
  };
  const reader = createEvidenceReader({ roots: [root], filesystem });
  let capturedTransaction;
  let settled = false;
  const pending = reader.withTextCorpus(
    root,
    root,
    { extensions: [".md"] },
    async (transaction) => {
      capturedTransaction = transaction;
      const mapped = await transaction.mapFiles(({ content }) => content);
      finalValidationArmed = true;
      return mapped;
    }
  );
  pending.finally(() => { settled = true; });

  await entered;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseValidation();
  assert.deepEqual(await pending, ["# Note\n"]);
  assert.throws(
    () => capturedTransaction.mapFiles(({ content }) => content),
    (error) => error?.code === "DOTAIOS_EVIDENCE_TRANSACTION_CLOSED"
  );
});

test("evidence corpus transactions preserve caller-work failures", async () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, "note.md"), "# Note\n");
  const reader = createEvidenceReader({ roots: [root] });
  const failure = new Error("ranking failed");

  await assert.rejects(
    () => reader.withTextCorpus(
      root,
      root,
      { extensions: [".md"] },
      async (transaction) => {
        await transaction.mapFiles(({ content }) => content);
        throw failure;
      }
    ),
    (error) => error === failure
  );
});

test("evidence corpus transactions reject root, ancestor, and enumerated-directory swaps", async (t) => {
  for (const kind of ["root", "ancestor", "directory"]) {
    await t.test(kind, async () => {
      const parent = tmpDir();
      const root = path.join(parent, "authorized");
      const ancestor = path.join(root, "nested");
      const corpus = path.join(ancestor, "corpus");
      fs.mkdirSync(corpus, { recursive: true });
      fs.writeFileSync(path.join(corpus, "note.md"), "# Original\n");
      const target = { root, ancestor, directory: corpus }[kind];
      const parked = `${target}-parked`;
      const reader = createEvidenceReader({ roots: [root] });

      await assert.rejects(
        () => reader.withTextCorpus(
          root,
          corpus,
          { extensions: [".md"] },
          async (transaction) => {
            await transaction.mapFiles(({ content }) => content);
            fs.renameSync(target, parked);
            fs.mkdirSync(target, { recursive: true });
            return `${kind} result must not escape`;
          }
        ),
        (error) => error?.code === "DOTAIOS_EVIDENCE_CHANGED"
      );
    });
  }
});

test("evidence corpus transactions reject a directory replacement at the enumeration-open barrier", async () => {
  const root = tmpDir();
  const corpus = path.join(root, "corpus");
  const parked = path.join(root, "corpus-parked");
  fs.mkdirSync(corpus);
  fs.writeFileSync(path.join(corpus, "note.md"), "# Original\n");
  let swapped = false;
  const filesystem = Object.create(fsp);
  filesystem.opendir = async (targetPath, options) => {
    if (!swapped && path.resolve(String(targetPath)) === path.resolve(corpus)) {
      swapped = true;
      await fsp.rename(corpus, parked);
      await fsp.mkdir(corpus);
      await fsp.writeFile(path.join(corpus, "note.md"), "# Replacement\n");
    }
    return fsp.opendir(targetPath, options);
  };
  const reader = createEvidenceReader({ roots: [root], filesystem });

  await assert.rejects(
    () => reader.withTextCorpus(
      root,
      corpus,
      { extensions: [".md"] },
      (transaction) => transaction.mapFiles(({ content }) => content)
    ),
    (error) => swapped && error?.code === "DOTAIOS_EVIDENCE_CHANGED"
  );
});

test("evidence corpus transactions bind every opened file to its enumerated parent identity", async () => {
  const root = tmpDir();
  const corpus = path.join(root, "corpus");
  const parked = path.join(root, "corpus-parked");
  const source = path.join(corpus, "note.md");
  fs.mkdirSync(corpus);
  fs.writeFileSync(source, "# Original\n\nORIGINAL_CANARY\n");
  let swapped = false;
  const filesystem = Object.create(fsp);
  filesystem.open = async (targetPath, flags) => {
    if (!swapped && path.resolve(String(targetPath)) === path.resolve(source)) {
      swapped = true;
      await fsp.rename(corpus, parked);
      await fsp.mkdir(corpus);
      await fsp.writeFile(source, "# Replacement\n\nREPLACEMENT_CANARY\n");
    }
    return fsp.open(targetPath, flags);
  };
  const reader = createEvidenceReader({ roots: [root], filesystem });

  await assert.rejects(
    () => reader.withTextCorpus(
      root,
      corpus,
      { extensions: [".md"] },
      (transaction) => transaction.mapFiles(({ content }) => content)
    ),
    (error) => swapped && error?.code === "DOTAIOS_EVIDENCE_CHANGED"
  );
});

test("evidence corpus transactions reject a final-component file swap before bytes are read", async () => {
  const root = tmpDir();
  const source = path.join(root, "note.md");
  const parked = path.join(root, "note-parked.md");
  fs.writeFileSync(source, "# Original\n\nORIGINAL_CANARY\n");
  let swapped = false;
  const filesystem = Object.create(fsp);
  filesystem.open = async (targetPath, flags) => {
    if (!swapped && path.resolve(String(targetPath)) === path.resolve(source)) {
      swapped = true;
      await fsp.rename(source, parked);
      await fsp.writeFile(source, "# Replacement\n\nREPLACEMENT_CANARY\n");
    }
    return fsp.open(targetPath, flags);
  };
  const reader = createEvidenceReader({ roots: [root], filesystem });

  await assert.rejects(
    () => reader.withTextCorpus(
      root,
      root,
      { extensions: [".md"] },
      (transaction) => transaction.mapFiles(({ content }) => content)
    ),
    (error) => swapped && error?.code === "DOTAIOS_EVIDENCE_CHANGED"
  );
});

test("evidence corpus transactions reject in-place file mutation during a handle read", async () => {
  const root = tmpDir();
  const source = path.join(root, "note.md");
  fs.writeFileSync(source, "# Original\n\nORIGINAL_CANARY\n");
  let mutated = false;
  const filesystem = Object.create(fsp);
  filesystem.open = async (targetPath, ...args) => {
    const handle = await fsp.open(targetPath, ...args);
    if (path.resolve(String(targetPath)) !== path.resolve(source)) return handle;
    return Object.create(handle, {
      read: { value: async (...readArgs) => {
        const result = await handle.read(...readArgs);
        if (!mutated && result.bytesRead > 0) {
          mutated = true;
          await fsp.writeFile(source, "# Mutated!\n\nMUTATION_CANARY\n");
        }
        return result;
      } }
    });
  };
  const reader = createEvidenceReader({ roots: [root], filesystem });

  await assert.rejects(
    () => reader.withTextCorpus(
      root,
      root,
      { extensions: [".md"] },
      (transaction) => transaction.mapFiles(({ content }) => content)
    ),
    (error) => mutated && error?.code === "DOTAIOS_EVIDENCE_CHANGED"
  );
});

test("evidence corpus transactions catch a synchronized swap and restore spanning final validation", async () => {
  const root = tmpDir();
  const corpus = path.join(root, "corpus");
  const parked = path.join(root, "corpus-parked");
  fs.mkdirSync(corpus);
  fs.writeFileSync(path.join(corpus, "note.md"), "# Stable bytes\n");
  let armed = false;
  let intercepted = false;
  const filesystem = Object.create(fsp);
  filesystem.lstat = async (targetPath, options) => {
    if (
      armed
      && !intercepted
      && path.resolve(String(targetPath)) === path.resolve(corpus)
      && options?.bigint === true
    ) {
      intercepted = true;
      await fsp.rename(corpus, parked);
      await fsp.mkdir(corpus);
      const replacement = await fsp.lstat(corpus, options);
      await fsp.rmdir(corpus);
      await fsp.rename(parked, corpus);
      return replacement;
    }
    return fsp.lstat(targetPath, options);
  };
  const reader = createEvidenceReader({ roots: [root], filesystem });

  await assert.rejects(
    () => reader.withTextCorpus(
      root,
      corpus,
      { extensions: [".md"] },
      async (transaction) => {
        await transaction.mapFiles(({ content }) => content);
        armed = true;
        return "must not escape";
      }
    ),
    (error) => intercepted && error?.code === "DOTAIOS_EVIDENCE_CHANGED"
  );
  // Portable Node can detect swaps that span an observation barrier. As in the
  // repository threat model, this does not claim immunity to an entirely
  // unobserved same-user ABA completed between barriers.
  assert.equal(fs.readFileSync(path.join(corpus, "note.md"), "utf8"), "# Stable bytes\n");
});

test("evidence corpus transactions reject eligible symlinks and non-regular files", {
  skip: process.platform === "win32" ? "mkfifo is unavailable on Windows" : false
}, async (t) => {
  await t.test("symbolic link", async () => {
    const root = tmpDir();
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "OUTSIDE_CANARY\n");
    fs.symlinkSync(outside, path.join(root, "linked.md"));
    const reader = createEvidenceReader({ roots: [root] });
    await assert.rejects(
      () => reader.withTextCorpus(
        root,
        root,
        { extensions: [".md"] },
        (transaction) => transaction.mapFiles(({ content }) => content)
      ),
      (error) => error?.code === "DOTAIOS_EVIDENCE_PATH_UNSAFE"
    );
  });

  await t.test("fifo", async () => {
    const root = tmpDir();
    const fifoPath = path.join(root, "blocked.md");
    const { spawnSync } = await import("node:child_process");
    assert.equal(spawnSync("mkfifo", [fifoPath]).status, 0);
    const reader = createEvidenceReader({ roots: [root] });
    await assert.rejects(
      () => reader.withTextCorpus(
        root,
        root,
        { extensions: [".md"] },
        (transaction) => transaction.mapFiles(({ content }) => content)
      ),
      (error) => error?.code === "DOTAIOS_EVIDENCE_NOT_REGULAR_FILE"
    );
  });
});

test("evidence corpus transactions reject invalid UTF-8 without changing source bytes", async () => {
  const root = tmpDir();
  const source = path.join(root, "invalid.md");
  const bytes = Buffer.from([0x23, 0x20, 0x58, 0x0a, 0xff, 0x0a]);
  fs.writeFileSync(source, bytes);
  const reader = createEvidenceReader({ roots: [root] });

  await assert.rejects(
    () => reader.withTextCorpus(
      root,
      root,
      { extensions: [".md"] },
      (transaction) => transaction.mapFiles(({ content }) => content)
    ),
    (error) => error?.code === "DOTAIOS_EVIDENCE_INVALID_UTF8"
  );
  assert.deepEqual(fs.readFileSync(source), bytes);
});

test("evidence corpus transactions retain every configured collection and byte ceiling", async (t) => {
  const cases = [
    {
      name: "file count",
      limits: { maxFiles: 1, maxBytes: 100, maxEntries: 10, maxFileBytes: 100, maxDirectoryEntries: 10 },
      files: [["one.md", "one\n"], ["two.md", "two\n"]],
      code: "DOTAIOS_EVIDENCE_BUDGET_EXCEEDED"
    },
    {
      name: "aggregate bytes",
      limits: { maxFiles: 2, maxBytes: 5, maxEntries: 10, maxFileBytes: 100, maxDirectoryEntries: 10 },
      files: [["one.md", "one\n"], ["two.md", "two\n"]],
      code: "DOTAIOS_EVIDENCE_BUDGET_EXCEEDED"
    },
    {
      name: "per-file bytes",
      limits: { maxFiles: 1, maxBytes: 100, maxEntries: 10, maxFileBytes: 3, maxDirectoryEntries: 10 },
      files: [["one.md", "one\n"]],
      code: "DOTAIOS_EVIDENCE_FILE_TOO_LARGE"
    },
    {
      name: "aggregate entries",
      limits: { maxFiles: 2, maxBytes: 100, maxEntries: 1, maxFileBytes: 100, maxDirectoryEntries: 10 },
      files: [["one.md", "one\n"], ["two.md", "two\n"]],
      code: "DOTAIOS_EVIDENCE_BUDGET_EXCEEDED"
    },
    {
      name: "directory entries",
      limits: { maxFiles: 2, maxBytes: 100, maxEntries: 10, maxFileBytes: 100, maxDirectoryEntries: 1 },
      files: [["one.md", "one\n"], ["two.md", "two\n"]],
      code: "DOTAIOS_EVIDENCE_DIRECTORY_TOO_LARGE"
    }
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = tmpDir();
      for (const [name, content] of fixture.files) fs.writeFileSync(path.join(root, name), content);
      const reader = createEvidenceReader({ roots: [root], limits: fixture.limits });
      await assert.rejects(
        () => reader.withTextCorpus(
          root,
          root,
          { extensions: [".md"] },
          (transaction) => transaction.mapFiles(({ content }) => content)
        ),
        (error) => error?.code === fixture.code
      );
    });
  }
});

test("scope preflight protects later scopes deterministically before redistributing capacity", async () => {
  const root = tmpDir();
  const counts = { large: 5, small: 1, later: 1 };
  for (const [scope, count] of Object.entries(counts)) {
    const directory = path.join(root, scope);
    fs.mkdirSync(directory);
    for (let index = 0; index < count; index += 1) {
      fs.writeFileSync(path.join(directory, `${index}.md`), `${scope}-${index}\n`);
    }
  }
  const reader = createEvidenceReader({
    roots: [root],
    limits: { maxBytes: 1024, maxFiles: 6, maxEntries: 100, maxFileBytes: 100, maxDirectoryEntries: 100 }
  });

  const result = await reader.withScopePreflight(
    ["large", "small", "later"],
    async (scope, scopeReader) => {
      const value = await scopeReader.withTextCorpus(
        root,
        path.join(root, scope),
        { extensions: [".md"] },
        (transaction) => transaction.mapFiles(({ content }) => content)
      );
      if (scope === "large") await new Promise((resolve) => setTimeout(resolve, 10));
      return value;
    },
    (transaction) => ({
      admitted: ["large", "small", "later"].filter((scope) => transaction.has(scope)),
      omissions: transaction.omissions
    })
  );

  assert.deepEqual(result.admitted, ["small", "later"]);
  assert.equal(result.omissions[0].scope, "large");
  assert.equal(result.omissions[0].reason, "file_count_exceeded");
});

test("scope preflight revalidates a partially enumerated omitted directory before publishing results", async () => {
  const root = tmpDir();
  const oversized = path.join(root, "oversized");
  const safe = path.join(root, "safe");
  fs.mkdirSync(oversized);
  fs.mkdirSync(safe);
  fs.writeFileSync(path.join(oversized, "one.md"), "one\n");
  fs.writeFileSync(path.join(oversized, "two.md"), "two\n");
  fs.writeFileSync(path.join(safe, "safe.md"), "safe\n");
  const reader = createEvidenceReader({
    roots: [root],
    limits: { maxBytes: 100, maxFiles: 10, maxEntries: 10, maxFileBytes: 100, maxDirectoryEntries: 1 }
  });

  await assert.rejects(
    () => reader.withScopePreflight(
      ["oversized", "safe"],
      (scope, scopeReader) => scopeReader.withTextCorpus(
        root,
        path.join(root, scope),
        { extensions: [".md"] },
        (transaction) => transaction.mapFiles(({ content }) => content)
      ),
      (transaction) => {
        assert.equal(transaction.has("safe"), true);
        assert.equal(transaction.has("oversized"), false);
        fs.writeFileSync(path.join(oversized, "late.md"), "late\n");
        return "must not escape";
      }
    ),
    (error) => error?.code === "DOTAIOS_EVIDENCE_CHANGED"
  );
});

test("scope preflight caps omissions at 32 plus one frozen aggregate remainder", async () => {
  const root = tmpDir();
  const scopes = Array.from({ length: 33 }, (_, index) => `scope-${String(index).padStart(2, "0")}`);
  for (const scope of scopes) {
    const directory = path.join(root, scope);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "oversized.md"), "xx");
  }
  const reader = createEvidenceReader({
    roots: [root],
    limits: { maxBytes: 100, maxFiles: 100, maxEntries: 100, maxFileBytes: 1, maxDirectoryEntries: 10 }
  });

  const omissions = await reader.withScopePreflight(
    scopes,
    (scope, scopeReader) => scopeReader.withTextCorpus(
      root,
      path.join(root, scope),
      { extensions: [".md"] },
      (transaction) => transaction.mapFiles(({ content }) => content)
    ),
    (transaction) => transaction.omissions
  );

  assert.equal(omissions.length, 33);
  assert.equal(omissions[31].scope, "scope-31");
  assert.deepEqual(omissions[32], {
    scope: "all",
    reason: "omissions_truncated",
    observed: { files: 0, bytes: 0, entries: 1 },
    inspection: "not_searched",
    recovery: {
      code: "narrow_scope",
      message: "Search one logical scope at a time to inspect every omission."
    }
  });
  assert.equal(Object.isFrozen(omissions), true);
  assert.equal(Object.isFrozen(omissions[32]), true);
});

test("scope preflight fails closed when one scope observes conflicting generations of the same directory", async () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, "events.jsonl"), '{"summary":"safe"}\n');
  const reader = createEvidenceReader({ roots: [root] });

  await assert.rejects(
    () => reader.withScopePreflight(
      ["memory"],
      async (_scope, scopeReader) => {
        await scopeReader.readJsonl(root, path.join(root, "events.jsonl"));
        fs.writeFileSync(path.join(root, "late.md"), "late\n");
        return scopeReader.readJsonl(root, path.join(root, "events.jsonl"));
      },
      () => "must not escape"
    ),
    (error) => error?.code === "DOTAIOS_EVIDENCE_CHANGED"
  );
});

test("evidence corpus file-operation growth stays constant per accepted file at fixed topology", async () => {
  async function measure(fileCount) {
    const root = tmpDir();
    for (let index = 0; index < fileCount; index += 1) {
      fs.writeFileSync(path.join(root, `${index}.md`), `# ${index}\n`);
    }
    const operations = { lstat: 0, realpath: 0, open: 0 };
    const filesystem = new Proxy(fsp, {
      get(target, property) {
        if (Object.hasOwn(operations, property)) {
          return async (...args) => {
            operations[property] += 1;
            return fsp[property](...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const reader = createEvidenceReader({ roots: [root], filesystem });
    const observed = await reader.withTextCorpus(
      root,
      root,
      { extensions: [".md"] },
      (transaction) => transaction.mapFiles(({ content }) => content)
    );
    assert.equal(observed.length, fileCount);
    assert.equal(operations.open, fileCount);
    return operations;
  }

  const one = await measure(1);
  const eight = await measure(8);
  assert.ok(eight.lstat - one.lstat <= 4 * 7, JSON.stringify({ one, eight }));
  assert.ok(eight.realpath - one.realpath <= 2 * 7, JSON.stringify({ one, eight }));
  assert.equal(eight.open - one.open, 7);
});
