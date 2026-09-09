import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ingestResearchSource } from "../../packages/cli/src/ingest/research.mjs";
const cli = fileURLToPath(new URL("../../packages/cli/src/index.mjs", import.meta.url));

test("research ingestion preserves original text and a source-bearing derivative in the work folder", async (t) => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-research-ingest-"));
  t.after(() => fs.rm(workdir, { recursive: true, force: true }));
  const body = "Plain text stays readable without a particular application.\n";
  const result = await ingestResearchSource("https://example.org/notes", { workdir }, {
    fetchSource: async () => ({
      requestedUrl: "https://example.org/notes", url: "https://example.org/notes",
      contentType: "text/plain", body: Buffer.from(body)
    })
  });
  assert.equal(result.status, "captured");
  assert.match(result.source.path, /^research\/sources\/[a-f0-9]+\.md$/);
  assert.equal(result.source.origin, "https://example.org/notes");
  assert.equal(await fs.readFile(path.join(workdir, result.original.path), "utf8"), body);
  const derivative = await fs.readFile(path.join(workdir, result.source.path), "utf8");
  assert.match(derivative, /source:.*https:\/\/example.org\/notes/);
  assert.ok(derivative.includes(body.trim()));
  assert.equal(result.original.sha256, "05bd8b105fafcd610d8ec9667a380782ed9c2ff000b1cd08e448c54f7bbde607");
  assert.deepEqual(await fs.readdir(workdir), ["research"]);
});

test("repeating the same research capture reports the preserved source bytes and refuses changed artifacts", async (t) => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-research-repeat-"));
  t.after(() => fs.rm(workdir, { recursive: true, force: true }));
  const fetchSource = async () => ({ requestedUrl: "https://example.org/research", url: "https://example.org/research",
    contentType: "text/plain", body: Buffer.from("Evidence remains evidence.\n") });
  const first = await ingestResearchSource("https://example.org/research", { workdir }, { fetchSource });
  await new Promise((resolve) => setTimeout(resolve, 15));
  const second = await ingestResearchSource("https://example.org/research", { workdir }, { fetchSource });
  assert.deepEqual(second.source, first.source);
  assert.equal((await fs.readdir(path.join(workdir, "research", "sources"))).length, 2);
  await fs.writeFile(path.join(workdir, first.source.path), "An edited conclusion.\n");
  await assert.rejects(ingestResearchSource("https://example.org/research", { workdir }, { fetchSource }),
    { code: "RESEARCH_SOURCE_CHANGED" });
  assert.equal(await fs.readFile(path.join(workdir, first.source.path), "utf8"), "An edited conclusion.\n");
});

test("capture resumes from a retained original when the readable derivative was not published", async (t) => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-research-partial-"));
  t.after(() => fs.rm(workdir, { recursive: true, force: true }));
  const fetchSource = async () => ({ requestedUrl: "https://example.org/source", url: "https://example.org/source",
    contentType: "text/plain", body: Buffer.from("Retained original evidence.\n") });
  const first = await ingestResearchSource("https://example.org/source", { workdir }, { fetchSource });
  const original = await fs.stat(path.join(workdir, first.original.path));
  await fs.rm(path.join(workdir, first.source.path));
  const resumed = await ingestResearchSource("https://example.org/source", { workdir }, { fetchSource });
  assert.deepEqual(resumed, first);
  assert.equal((await fs.stat(path.join(workdir, first.original.path))).mtimeMs, original.mtimeMs);
});

test("a redirected research source folder cannot receive saved artifacts", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-research-containment-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workdir = path.join(root, "work");
  const outside = path.join(root, "outside");
  await fs.mkdir(path.join(workdir, "research"), { recursive: true });
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(workdir, "research", "sources"));
  await assert.rejects(ingestResearchSource("https://example.org/source", { workdir }, {
    fetchSource: async () => ({ requestedUrl: "https://example.org/source", url: "https://example.org/source",
      contentType: "text/plain", body: Buffer.from("Retained original evidence.\n") })
  }));
  assert.deepEqual(await fs.readdir(outside), []);
});

test("HTML research retains its original separately and extracts readable cited text", async (t) => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-research-html-"));
  t.after(() => fs.rm(workdir, { recursive: true, force: true }));
  const html = '<html><head><title>Readable files</title></head><body><nav>Navigation noise</nav><article><h1>Readable files</h1><p>Plain text documents preserve their content without a particular editor. A folder of readable notes can be opened with ordinary tools and exchanged independently from the application used to write it.</p><p>Keep the original source beside a derived report. Readers can verify each statement against the retained evidence, and a future writer can continue from the exact document version previously inspected.</p></article></body></html>';
  const result = await ingestResearchSource("https://example.org/article", { workdir }, {
    fetchSource: async () => ({ requestedUrl: "https://example.org/article", url: "https://example.org/article",
      contentType: "text/html", body: Buffer.from(html) })
  });
  assert.match(result.original.path, /\.html$/);
  assert.equal(await fs.readFile(path.join(workdir, result.original.path), "utf8"), html);
  const text = await fs.readFile(path.join(workdir, result.source.path), "utf8");
  assert.match(text, /Plain text documents preserve/);
  assert.doesNotMatch(text, /<article>|Navigation noise/);
  assert.match(text, /title: Readable files/);
});

test("unextractable HTML reports a useful research refusal without claiming a saved source", async (t) => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-research-extraction-"));
  t.after(() => fs.rm(workdir, { recursive: true, force: true }));
  await assert.rejects(ingestResearchSource("https://example.org/article", { workdir }, {
    fetchSource: async () => ({ requestedUrl: "https://example.org/article", url: "https://example.org/article",
      contentType: "text/html", body: Buffer.from('<html><body><script>loadArticle()</script></body></html>') })
  }), { code: "RESEARCH_EXTRACTION_FAILED" });
  assert.deepEqual(await fs.readdir(workdir), []);
});

test("work-folder ingest preview is structured and independent of personal AIOS", async (t) => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-research-preview-"));
  t.after(() => fs.rm(workdir, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [cli, "ingest", "https://example.org/article", "--workdir", workdir, "--dry-run", "--json"], {
    cwd: workdir, env: { ...process.env, HOME: workdir, DOTAIOS_ALLOW_AUTO_SYNC_HOOK: "1" }, encoding: "utf8"
  });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, "preview");
  assert.equal(result.destination, "research/sources");
  assert.deepEqual(await fs.readdir(workdir), []);
});

test("work-folder ingest preview refuses unsafe or credentialed URLs before writing", async (t) => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-research-refusal-"));
  t.after(() => fs.rm(workdir, { recursive: true, force: true }));
  for (const url of ["file:///etc/hosts", "http://127.0.0.1/source", "https://user:secret@example.org/source"]) {
    const run = spawnSync(process.execPath, [cli, "ingest", url, "--workdir", workdir, "--dry-run", "--json"], {
      cwd: workdir, env: { ...process.env, HOME: workdir }, encoding: "utf8"
    });
    assert.equal(run.status, 1, url);
    const result = JSON.parse(run.stdout);
    assert.equal(result.status, "error");
    assert.match(result.code, /^DOTAIOS_PUBLIC_SOURCE_URL_(INVALID|UNSAFE)$/);
    assert.ok(!run.stdout.includes("secret"));
  }
  assert.deepEqual(await fs.readdir(workdir), []);
});

test("work-folder ingest returns a structured refusal for mixed scope or malformed options", async (t) => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-research-options-"));
  t.after(() => fs.rm(workdir, { recursive: true, force: true }));
  for (const flags of [["--path", workdir], ["--timeout", "invalid"], ["--workdir", workdir]]) {
    const run = spawnSync(process.execPath, [cli, "ingest", "https://example.org/article", "--workdir", workdir, "--dry-run", "--json", ...flags], {
      cwd: workdir, env: { ...process.env, HOME: workdir }, encoding: "utf8"
    });
    assert.equal(run.status, 1);
    assert.equal(JSON.parse(run.stdout).status, "error");
  }
  assert.deepEqual(await fs.readdir(workdir), []);
});

test("malformed work-folder flags never fall through to AIOS ingestion", async (t) => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-research-malformed-"));
  t.after(() => fs.rm(workdir, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [cli, "ingest", "https://example.org/article", "--workdir=.", "--dry-run"], {
    cwd: workdir, env: { ...process.env, HOME: workdir }, encoding: "utf8"
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--workdir <dir>/);
  assert.deepEqual(await fs.readdir(workdir), []);
});

test("a replaced work-folder root is refused after fetching and receives no artifacts", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-research-root-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const workdir = path.join(parent, "work");
  await fs.mkdir(workdir);
  await assert.rejects(ingestResearchSource("https://example.org/article", { workdir }, {
    fetchSource: async () => {
      await fs.rename(workdir, path.join(parent, "original"));
      await fs.mkdir(workdir);
      return { requestedUrl: "https://example.org/article", url: "https://example.org/article",
        contentType: "text/plain", body: Buffer.from("A real source.\n") };
    }
  }), { code: "RESEARCH_WORKDIR_CHANGED" });
  assert.deepEqual(await fs.readdir(workdir), []);
  assert.deepEqual(await fs.readdir(path.join(parent, "original")), []);
});

test("empty and invalid UTF-8 sources produce no research artifacts", async (t) => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-research-text-"));
  t.after(() => fs.rm(workdir, { recursive: true, force: true }));
  for (const body of [Buffer.from(" \n"), Buffer.from([0xff, 0xfe])]) {
    await assert.rejects(ingestResearchSource("https://example.org/text", { workdir }, {
      fetchSource: async () => ({ requestedUrl: "https://example.org/text", url: "https://example.org/text", contentType: "text/plain", body })
    }), { code: "RESEARCH_TEXT_UNREADABLE" });
    assert.deepEqual(await fs.readdir(workdir), []);
  }
});
