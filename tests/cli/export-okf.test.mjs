import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportBundle } from "../../packages/cli/src/commands/export-okf.mjs";
import { listFiles } from "../../packages/core/src/files.mjs";

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "okf-"));
  await fs.mkdir(path.join(dir, "context"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "context", "identity.md"),
    "---\ntitle: Me\ndescription: who I am\n---\n\nBody links to [[orders]].\n"
  );
  await fs.mkdir(path.join(dir, "vault", "raw"), { recursive: true });
  await fs.writeFile(path.join(dir, "vault", "raw", "orders.md"), "# Orders\nno frontmatter here\n");
  return dir;
}

test("root index.md declares okf_version", async () => {
  const src = await fixture();
  const out = path.join(src, "build", "okf");
  await exportBundle({ srcRoot: src, outDir: out });
  const idx = await fs.readFile(path.join(out, "index.md"), "utf8");
  assert.match(idx, /okf_version: "0\.1"/);
});

test("every concept has a non-empty type", async () => {
  const src = await fixture();
  const out = path.join(src, "build", "okf");
  const stats = await exportBundle({ srcRoot: src, outDir: out });
  const concepts = (await listFiles(out)).filter((f) => f.endsWith(".md") && path.basename(f) !== "index.md");
  assert.ok(concepts.length >= 2, "expected concept files");
  for (const f of concepts) {
    const text = await fs.readFile(f, "utf8");
    assert.ok(text.startsWith("---\ntype:"), `${f} missing required type`);
  }
  assert.equal(stats.conformant, stats.concepts);
});

test("source files are never mutated", async () => {
  const src = await fixture();
  const orders = path.join(src, "vault", "raw", "orders.md");
  const before = await fs.readFile(orders, "utf8");
  await exportBundle({ srcRoot: src, outDir: path.join(src, "build", "okf") });
  assert.equal(await fs.readFile(orders, "utf8"), before);
});

test("resolvable [[wikilink]] becomes an absolute /path.md link", async () => {
  const src = await fixture();
  const out = path.join(src, "build", "okf");
  await exportBundle({ srcRoot: src, outDir: out });
  const identity = await fs.readFile(path.join(out, "context", "identity.md"), "utf8");
  assert.match(identity, /\[orders\]\(\/vault\/raw\/orders\.md\)/);
});

test("preserves custom frontmatter keys (OKF: keep unknown keys)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "okf-"));
  await fs.mkdir(path.join(dir, "vault", "research", "scout"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "vault", "research", "scout", "x.md"),
    "---\ntitle: X\nadopt: YES\nconfidence: high\n---\n\nbody\n"
  );
  const out = path.join(dir, "out");
  await exportBundle({ srcRoot: dir, outDir: out });
  const t = await fs.readFile(path.join(out, "vault", "research", "scout", "x.md"), "utf8");
  assert.match(t, /type:/, "required type injected");
  assert.match(t, /adopt: YES/, "custom key preserved");
  assert.match(t, /confidence: high/, "custom key preserved");
});

test("rejects an output path equal to the AIOS root without deleting sources", async () => {
  const src = await fixture();
  const identity = path.join(src, "context", "identity.md");
  const before = await fs.readFile(identity, "utf8");

  await assert.rejects(
    () => exportBundle({ srcRoot: src, outDir: src }),
    /cannot equal or contain the AIOS folder/
  );

  assert.equal(await fs.readFile(identity, "utf8"), before);
});

test("rejects output paths that overlap a source shelf", async () => {
  const src = await fixture();
  const out = path.join(src, "vault", "okf-export");

  await assert.rejects(
    () => exportBundle({ srcRoot: src, outDir: out }),
    /overlaps source folder/
  );

  assert.equal(await fs.readFile(path.join(src, "vault", "raw", "orders.md"), "utf8"), "# Orders\nno frontmatter here\n");
});

test("invalid YAML fails before replacing an existing export", async () => {
  const src = await fixture();
  const out = path.join(src, "build", "okf");
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, "sentinel.txt"), "keep me");
  await fs.writeFile(path.join(src, "context", "broken.md"), "---\ntype: Reference\ntags: [broken\n---\nbody\n");

  await assert.rejects(
    () => exportBundle({ srcRoot: src, outDir: out }),
    /Invalid YAML frontmatter/
  );

  assert.equal(await fs.readFile(path.join(out, "sentinel.txt"), "utf8"), "keep me");
});

test("unclosed YAML frontmatter fails before replacing an existing export", async () => {
  const src = await fixture();
  const out = path.join(src, "build", "okf");
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, "sentinel.txt"), "keep me");
  await fs.writeFile(
    path.join(src, "context", "unclosed.md"),
    "---\ntype: Reference\ntags: [release, safety]\n\nBody without a closing delimiter.\n"
  );

  await assert.rejects(
    () => exportBundle({ srcRoot: src, outDir: out }),
    /Unclosed YAML frontmatter/
  );

  assert.equal(await fs.readFile(path.join(out, "sentinel.txt"), "utf8"), "keep me");
});

test("ambiguous bare wikilinks remain unresolved", async () => {
  const src = await fixture();
  await fs.mkdir(path.join(src, "vault", "wiki", "alpha"), { recursive: true });
  await fs.mkdir(path.join(src, "vault", "wiki", "beta"), { recursive: true });
  await fs.writeFile(path.join(src, "vault", "wiki", "alpha", "note.md"), "# Alpha\n");
  await fs.writeFile(path.join(src, "vault", "wiki", "beta", "note.md"), "# Beta\n");
  await fs.writeFile(path.join(src, "context", "identity.md"), "# Identity\n\nSee [[note]].\n");
  const out = path.join(src, "build", "okf");

  const stats = await exportBundle({ srcRoot: src, outDir: out });
  const identity = await fs.readFile(path.join(out, "context", "identity.md"), "utf8");

  assert.match(identity, /\[\[note\]\]/);
  assert.equal(stats.ambiguous, 1);
});

test("qualified wikilinks resolve when stems are duplicated", async () => {
  const src = await fixture();
  await fs.mkdir(path.join(src, "vault", "wiki", "alpha"), { recursive: true });
  await fs.mkdir(path.join(src, "vault", "wiki", "beta"), { recursive: true });
  await fs.writeFile(path.join(src, "vault", "wiki", "alpha", "note.md"), "# Alpha\n");
  await fs.writeFile(path.join(src, "vault", "wiki", "beta", "note.md"), "# Beta\n");
  await fs.writeFile(path.join(src, "context", "identity.md"), "# Identity\n\nSee [[vault/wiki/alpha/note]].\n");
  const out = path.join(src, "build", "okf");

  await exportBundle({ srcRoot: src, outDir: out });
  const identity = await fs.readFile(path.join(out, "context", "identity.md"), "utf8");

  assert.match(identity, /\[vault\/wiki\/alpha\/note\]\(\/vault\/wiki\/alpha\/note\.md\)/);
});

test("writes ancestor indexes for nested concepts", async () => {
  const src = await fixture();
  await fs.mkdir(path.join(src, "vault", "wiki", "topic"), { recursive: true });
  await fs.writeFile(path.join(src, "vault", "wiki", "topic", "note.md"), "# Note\n");
  const out = path.join(src, "build", "okf");

  await exportBundle({ srcRoot: src, outDir: out });

  await fs.access(path.join(out, "vault", "index.md"));
  await fs.access(path.join(out, "vault", "wiki", "index.md"));
  await fs.access(path.join(out, "vault", "wiki", "topic", "index.md"));
});
