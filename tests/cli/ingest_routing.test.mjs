import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import {
  SHELVES,
  isShelf,
  isDurableShelf,
  shelfNeedsName,
  shelfMarkdownPath,
  todayStamp
} from "../../packages/cli/src/ingest/placement.mjs";
import { ingestUrl } from "../../packages/cli/src/ingest/web.mjs";
import { isoDate } from "../../packages/core/src/memory.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

test("todayStamp uses the canonical LOCAL isoDate, not UTC", () => {
  // 00:30 local: in any timezone ahead of UTC this instant is the PREVIOUS day
  // in UTC, so a toISOString()-based stamp returns the wrong calendar day. The
  // stamp must match where signals are actually written (memory.isoDate, local).
  // (On a host whose local time is UTC the two coincide; this still locks intent.)
  const nearMidnight = new Date(2026, 0, 15, 0, 30, 0);
  assert.equal(todayStamp(() => nearMidnight), isoDate(nearMidnight));
  assert.equal(todayStamp(() => nearMidnight), "2026-01-15");
});

test("placement helpers describe the shelf set", () => {
  assert.deepEqual(SHELVES, ["raw", "wiki", "company", "person", "signal"]);
  assert.equal(isShelf("wiki"), true);
  assert.equal(isShelf("nope"), false);
  assert.equal(isDurableShelf("wiki"), true);
  assert.equal(isDurableShelf("company"), true);
  assert.equal(isDurableShelf("person"), true);
  assert.equal(isDurableShelf("raw"), false);
  assert.equal(isDurableShelf("signal"), false);
  assert.equal(shelfNeedsName("company"), true);
  assert.equal(shelfNeedsName("person"), true);
  assert.equal(shelfNeedsName("wiki"), false);
});

test("shelfMarkdownPath maps each markdown shelf to its file", () => {
  const vaultRoot = "/v";
  assert.equal(shelfMarkdownPath({ shelf: "wiki", vaultRoot, slug: "ai" }), "/v/wiki/ai/_index.md");
  assert.equal(shelfMarkdownPath({ shelf: "company", vaultRoot, slug: "acme" }), "/v/org/companies/acme.md");
  assert.equal(shelfMarkdownPath({ shelf: "person", vaultRoot, slug: "jane" }), "/v/org/people/jane.md");
});

test("ingest with no --to keeps the vault/raw default and points at --to", () => {
  const { aiosPath, file } = setup("note.txt", "A quick working note.");

  const result = run(["ingest", file, "--path", aiosPath]);

  assert.match(result.stdout, /vault\/raw/);
  assert.match(result.stdout, /--to wiki\|company\|person\|signal/);
  assert.equal(fs.existsSync(path.join(aiosPath, "vault", "raw", "note.md")), true);
});

test("ingest --to raw writes to vault/raw", () => {
  const { aiosPath, file } = setup("ref.txt", "Raw source body.");

  run(["ingest", file, "--path", aiosPath, "--to", "raw"]);

  assert.match(read(path.join(aiosPath, "vault", "raw", "ref.md")), /Raw source body/);
});

test("ingest --to with an unknown shelf fails", () => {
  const { aiosPath, file } = setup("x.txt", "body");
  const result = runFail(["ingest", file, "--path", aiosPath, "--to", "bogus"]);
  assert.match(result.stderr, /Unknown shelf/);
});

test("ingest --to wiki without --apply previews and writes nothing", () => {
  const { aiosPath, file } = setup("guide.txt", "A lasting reference.");

  const result = run(["ingest", file, "--path", aiosPath, "--to", "wiki", "--name", "ai-research"]);

  assert.match(result.stdout, /\[preview\]/);
  assert.match(result.stdout, /--apply/);
  assert.equal(fs.existsSync(path.join(aiosPath, "vault", "wiki", "ai-research", "_index.md")), false);
});

test("ingest --to wiki --apply writes the durable knowledge shelf", () => {
  const { aiosPath, file } = setup("guide.txt", "A lasting reference.");

  run(["ingest", file, "--path", aiosPath, "--to", "wiki", "--name", "ai-research", "--apply"]);

  const written = read(path.join(aiosPath, "vault", "wiki", "ai-research", "_index.md"));
  assert.match(written, /A lasting reference/);
});

test("ingest --to company requires --name when not interactive", () => {
  const { aiosPath, file } = setup("brief.txt", "Company brief.");
  const result = runFail(["ingest", file, "--path", aiosPath, "--to", "company"]);
  assert.match(result.stderr, /needs --name/);
});

test("ingest --to company --apply writes an org record and appends on repeat", () => {
  const { aiosPath, tempRoot } = setup("brief.txt", "First brief about Acme.");
  const fileA = path.join(tempRoot, "brief.txt");
  const fileB = path.join(tempRoot, "update.txt");
  fs.writeFileSync(fileB, "Second brief about Acme.");

  run(["ingest", fileA, "--path", aiosPath, "--to", "company", "--name", "acme", "--apply"]);
  const recordPath = path.join(aiosPath, "vault", "org", "companies", "acme.md");
  assert.match(read(recordPath), /First brief about Acme/);

  const second = run(["ingest", fileB, "--path", aiosPath, "--to", "company", "--name", "acme", "--apply"]);
  assert.match(second.stdout, /Appended/);
  const merged = read(recordPath);
  assert.match(merged, /First brief about Acme/);
  assert.match(merged, /Second brief about Acme/);
  assert.match(merged, /## Ingested \d{4}-\d{2}-\d{2}/);
});

test("ingest --to person --apply writes to vault/org/people", () => {
  const { aiosPath, file } = setup("bio.txt", "Notes on Jane Doe.");

  run(["ingest", file, "--path", aiosPath, "--to", "person", "--name", "jane-doe", "--apply"]);

  assert.match(read(path.join(aiosPath, "vault", "org", "people", "jane-doe.md")), /Notes on Jane Doe/);
});

test("ingest --to signal logs a working note in memory/signals", () => {
  const { aiosPath, file } = setup("call.txt", "Quick call note: follow up next week.");

  const result = run(["ingest", file, "--path", aiosPath, "--to", "signal"]);

  assert.match(result.stdout, /memory\/signals/);
  // Signals are written with the local date (memory.isoDate), so the expected
  // filename must use the same convention — toISOString() (UTC) drifts by a day
  // near the local-midnight boundary and makes this test flaky.
  const today = isoDate(new Date());
  const signalFile = path.join(aiosPath, "memory", "signals", `${today}.jsonl`);
  assert.equal(fs.existsSync(signalFile), true);
  const entry = JSON.parse(read(signalFile).trim().split(/\r?\n/).pop());
  assert.equal(entry.type, "ingest-note");
  assert.match(entry.note, /follow up next week/);
});

test("ingest --dry-run --to wiki shows the shelf and target without writing", () => {
  const { aiosPath, file } = setup("plan.txt", "body");

  const result = run(["ingest", file, "--path", aiosPath, "--to", "wiki", "--name", "planning", "--dry-run"]);

  assert.match(result.stdout, /shelf:\s+wiki/);
  assert.match(result.stdout, /wiki\/planning\/_index\.md/);
  assert.equal(fs.existsSync(path.join(aiosPath, "vault", "wiki", "planning", "_index.md")), false);
});

function setup(fileName, body) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-ingest-route-"));
  const aiosPath = path.join(tempRoot, "aios");
  run(["init", "--path", aiosPath, "--yes"]);
  const file = path.join(tempRoot, fileName);
  fs.writeFileSync(file, body);
  return { aiosPath, tempRoot, file };
}

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Command failed: dotaios ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function runFail(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8" });
  if (result.status === 0) {
    throw new Error(`Command unexpectedly passed: dotaios ${args.join(" ")}\n${result.stdout}`);
  }
  return result;
}

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function htmlFixture(title = "Lightpanda Rendered") {
  return `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${"Body paragraph. ".repeat(60)}</p></article></body></html>`;
}

function makeFakeFetch({ body = htmlFixture(), status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    headers: { get: () => "text/html; charset=utf-8" }
  });
}

function makeWebWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-lp-web-"));
  return {
    root,
    rawDir: path.join(root, "vault", "raw"),
    assetsDir: path.join(root, "vault", "assets"),
    eventsPath: path.join(root, "memory", "events.jsonl"),
    hintFlagPath: path.join(root, "lightpanda_hint_shown")
  };
}

test("ingestUrl uses lightpanda when resolver returns a path and spawn succeeds", async () => {
  const ws = makeWebWorkspace();
  const html = htmlFixture("Lightpanda Win");
  const result = await ingestUrl("https://example.com/lp-win", {
    rawDir: ws.rawDir,
    eventsPath: ws.eventsPath,
    fetchImpl: makeFakeFetch({ body: "<html><body>SHOULD NOT BE USED</body></html>" }),
    resolveLightpandaImpl: async () => "/fake/lightpanda",
    spawnImpl: () => ({ status: 0, stdout: html, stderr: "" }),
    hintFlagPath: ws.hintFlagPath,
    now: () => new Date("2026-05-18T12:00:00Z")
  });
  assert.equal(result.action, "written");
  assert.equal(result.parser, "lightpanda+readability+turndown");
  const written = fs.readFileSync(result.destination, "utf8");
  assert.match(written, /parser: lightpanda\+readability\+turndown/);
  assert.match(written, /Lightpanda Win/);
});

test("ingestUrl falls back to plain fetch when lightpanda spawn fails", async () => {
  const ws = makeWebWorkspace();
  const html = htmlFixture("Plain Fetch Fallback");
  const result = await ingestUrl("https://example.com/fallback", {
    rawDir: ws.rawDir,
    eventsPath: ws.eventsPath,
    fetchImpl: makeFakeFetch({ body: html }),
    resolveLightpandaImpl: async () => "/fake/lightpanda",
    spawnImpl: () => ({ status: 1, stdout: "", stderr: "boom" }),
    hintFlagPath: ws.hintFlagPath,
    now: () => new Date("2026-05-18T12:00:00Z")
  });
  assert.equal(result.action, "written");
  assert.equal(result.parser, "readability+turndown");
  const written = fs.readFileSync(result.destination, "utf8");
  assert.match(written, /parser: readability\+turndown/);
  assert.match(written, /Plain Fetch Fallback/);
});

test("ingestUrl uses plain fetch when lightpanda not found and writes hint flag once", async () => {
  const ws = makeWebWorkspace();
  const html = htmlFixture("Plain No Lightpanda");
  const opts = {
    rawDir: ws.rawDir,
    eventsPath: ws.eventsPath,
    fetchImpl: makeFakeFetch({ body: html }),
    resolveLightpandaImpl: async () => null,
    spawnImpl: () => { throw new Error("must not spawn"); },
    hintFlagPath: ws.hintFlagPath,
    lightpandaPlatformSupported: true,
    now: () => new Date("2026-05-18T12:00:00Z")
  };
  const result = await ingestUrl("https://example.com/nope", opts);
  assert.equal(result.parser, "readability+turndown");
  assert.equal(fs.existsSync(ws.hintFlagPath), true);

  // Second call must not re-create / re-print (flag already exists)
  const html2 = htmlFixture("Second Call");
  const second = await ingestUrl("https://example.com/nope2", {
    ...opts,
    fetchImpl: makeFakeFetch({ body: html2 })
  });
  assert.equal(second.parser, "readability+turndown");
});

test("ingestUrl skips lightpanda for PDF URLs and routes through Path B (regression)", async () => {
  const ws = makeWebWorkspace();
  const pdfBytes = buildMinimalPdf("Regression PDF");

  const result = await ingestUrl("https://example.com/paper.pdf", {
    rawDir: ws.rawDir,
    assetsDir: ws.assetsDir,
    eventsPath: ws.eventsPath,
    fetchImpl: makePdfFetch(pdfBytes),
    resolveLightpandaImpl: async () => "/fake/lightpanda",
    spawnImpl: () => { throw new Error("must not spawn for PDF URLs"); },
    hintFlagPath: ws.hintFlagPath,
    lightpandaPlatformSupported: true,
    documentOptions: {
      whichImpl: async () => null,
      extractPdfImpl: async () => "Extracted PDF text."
    },
    now: () => new Date("2026-05-18T12:00:00Z")
  });

  assert.equal(result.kind, "pdf");
  assert.equal(result.parser, "unpdf");
  // Hint flag must NOT be written — PDFs bypass the lightpanda hint logic entirely
  assert.equal(fs.existsSync(ws.hintFlagPath), false);
});

// --- helpers ---

function buildMinimalPdf(message = "Hello DotAIOS Test") {
  const stream = `BT /F1 24 Tf 100 700 Td (${message}) Tj ET\n`;
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>/Contents 4 0 R>>",
    `<</Length ${stream.length}>>stream\n${stream}endstream`
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    body += `${off.toString().padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, "binary");
}

function makePdfFetch(pdfBytes) {
  const buf = pdfBytes instanceof Buffer ? pdfBytes : Buffer.from(pdfBytes);
  return async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => buf.toString("binary"),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    headers: { get: (name) => name.toLowerCase() === "content-type" ? "application/pdf" : null }
  });
}
