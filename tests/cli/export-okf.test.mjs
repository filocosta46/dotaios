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
