import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

function runCli(args, { expectFail = false } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (!expectFail && result.status !== 0) {
    throw new Error(`Command failed: dotaios ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  if (expectFail && result.status === 0) {
    throw new Error(`Command unexpectedly passed: dotaios ${args.join(" ")}\n${result.stdout}`);
  }
  return result;
}

function setupAiosWorkspace() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-v140-cli-"));
  const aiosPath = path.join(tempRoot, "aios");
  runCli(["init", "--path", aiosPath, "--yes"]);
  return { aiosPath, tempRoot };
}

const ingestDir = path.resolve(
  new URL("../../packages/cli/src/ingest/", import.meta.url).pathname
);
const fixturesDir = path.resolve(new URL("../fixtures/", import.meta.url).pathname);

const { classifyInput, isUrl } = await import(path.join(ingestDir, "route.mjs"));
const { canonicalizeUrl } = await import(path.join(ingestDir, "canonical-url.mjs"));
const {
  buildFrontmatter,
  ensureFrontmatter,
  slugify,
  disambiguateSlug
} = await import(path.join(ingestDir, "frontmatter.mjs"));
const { ingestUrl, IngestError, detectBlockedExtraction } = await import(path.join(ingestDir, "web.mjs"));
const { ingestDocument, detectMarker } = await import(path.join(ingestDir, "pdf.mjs"));
const { ingestText } = await import(path.join(ingestDir, "text.mjs"));
const { ingestBinary } = await import(path.join(ingestDir, "binary.mjs"));
const { defaultAiosPath } = await import(path.join(repoRoot, "packages", "core", "src", "paths.mjs"));

// --- classifier ---

test("classifyInput routes http and https URLs to web", () => {
  assert.equal(classifyInput("http://example.com").kind, "web");
  assert.equal(classifyInput("https://example.com/page").kind, "web");
  assert.equal(classifyInput("HTTPS://EXAMPLE.COM").kind, "web");
});

test("classifyInput routes document extensions to document", () => {
  for (const ext of [".pdf", ".docx", ".pptx", ".epub"]) {
    const result = classifyInput(`/tmp/sample${ext}`);
    assert.equal(result.kind, "document");
    assert.equal(result.ext, ext);
  }
});

test("classifyInput routes case-insensitive document extensions", () => {
  assert.equal(classifyInput("/tmp/REPORT.PDF").kind, "document");
});

test("classifyInput routes text extensions to text", () => {
  for (const ext of [".md", ".txt", ".json", ".csv"]) {
    assert.equal(classifyInput(`/tmp/sample${ext}`).kind, "text");
  }
});

test("classifyInput routes unknown extensions to binary", () => {
  assert.equal(classifyInput("/tmp/blob.zip").kind, "binary");
  assert.equal(classifyInput("/tmp/no-ext").kind, "binary");
});

test("classifyInput resolves file paths to absolute", () => {
  const result = classifyInput("./relative.pdf");
  assert.ok(path.isAbsolute(result.target));
});

test("classifyInput rejects empty input", () => {
  assert.throws(() => classifyInput(""), /non-empty string/);
  assert.throws(() => classifyInput(null), /non-empty string/);
});

test("isUrl distinguishes http(s) from local paths", () => {
  assert.equal(isUrl("https://x.com"), true);
  assert.equal(isUrl("ftp://x.com"), false);
  assert.equal(isUrl("/tmp/file.pdf"), false);
});

// --- canonicalizeUrl ---

test("canonicalizeUrl strips fragment", () => {
  assert.equal(
    canonicalizeUrl("https://example.com/post#section"),
    "https://example.com/post"
  );
});

test("canonicalizeUrl strips utm_* and known tracking params", () => {
  const url =
    "https://example.com/post?utm_source=twitter&utm_medium=social&ref=feed&fbclid=abc&id=42";
  assert.equal(canonicalizeUrl(url), "https://example.com/post?id=42");
});

test("canonicalizeUrl preserves meaningful query params", () => {
  assert.equal(
    canonicalizeUrl("https://example.com/search?q=foo&page=2"),
    "https://example.com/search?page=2&q=foo"
  );
});

test("canonicalizeUrl sorts remaining query params for stability", () => {
  const a = canonicalizeUrl("https://example.com/?b=2&a=1");
  const b = canonicalizeUrl("https://example.com/?a=1&b=2");
  assert.equal(a, b);
});

test("canonicalizeUrl lowercases protocol and host but not path", () => {
  assert.equal(
    canonicalizeUrl("HTTPS://Example.COM/Path/Item"),
    "https://example.com/Path/Item"
  );
});

test("canonicalizeUrl strips trailing slash but keeps root slash", () => {
  assert.equal(canonicalizeUrl("https://example.com/post/"), "https://example.com/post");
  assert.equal(canonicalizeUrl("https://example.com/"), "https://example.com/");
});

test("canonicalizeUrl throws on malformed URL", () => {
  assert.throws(() => canonicalizeUrl("not a url"));
});

// --- frontmatter ---

test("buildFrontmatter produces required keys", () => {
  const block = buildFrontmatter({
    source: "https://example.com/post",
    kind: "web",
    parser: "readability+turndown",
    title: "Hello world",
    ingestedAt: "2026-05-10T14:00:00Z"
  });
  assert.match(block, /^---\n/);
  assert.match(block, /\nsource: https:\/\/example\.com\/post\n/);
  assert.match(block, /\ningested_at: 2026-05-10T14:00:00Z\n/);
  assert.match(block, /\nkind: web\n/);
  assert.match(block, /\nparser: readability\+turndown\n/);
  assert.match(block, /\ntitle: Hello world\n/);
  assert.match(block, /\ntags: \[\]\n/);
  assert.match(block, /\n---\n$/);
});

test("buildFrontmatter quotes titles containing YAML-special characters", () => {
  const block = buildFrontmatter({
    source: "/tmp/doc.pdf",
    kind: "pdf",
    parser: "unpdf",
    title: "Foo: A guide to bar"
  });
  assert.match(block, /\ntitle: "Foo: A guide to bar"\n/);
});

test("buildFrontmatter formats non-empty tags as inline array", () => {
  const block = buildFrontmatter({
    source: "/tmp/doc.pdf",
    kind: "pdf",
    parser: "unpdf",
    title: "Doc",
    tags: ["alpha", "beta gamma"]
  });
  assert.match(block, /\ntags: \[alpha, "beta gamma"\]\n/);
});

test("buildFrontmatter rejects missing required fields", () => {
  assert.throws(() => buildFrontmatter({ kind: "web", parser: "x", title: "y" }), /source/);
  assert.throws(() => buildFrontmatter({ source: "s", parser: "x", title: "y" }), /kind/);
  assert.throws(() => buildFrontmatter({ source: "s", kind: "web", title: "y" }), /parser/);
  assert.throws(() => buildFrontmatter({ source: "s", kind: "web", parser: "x" }), /title/);
});

test("ensureFrontmatter prepends only when frontmatter absent", () => {
  const fields = {
    source: "/tmp/x.txt",
    kind: "text",
    parser: "copy",
    title: "x"
  };
  const body = "Some body text";
  const wrapped = ensureFrontmatter(body, fields);
  assert.match(wrapped, /^---\n/);
  assert.ok(wrapped.includes(body));

  const already = `---\nsource: /a\nkind: text\nparser: copy\ntitle: a\ntags: []\n---\n\nbody`;
  assert.equal(ensureFrontmatter(already, fields), already);
});

test("slugify produces kebab-case ASCII", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("Foo: A guide to bar!"), "foo-a-guide-to-bar");
  assert.equal(slugify("café résumé"), "cafe-resume");
  assert.equal(slugify("   leading and trailing   "), "leading-and-trailing");
});

test("slugify falls back to untitled when input collapses to empty", () => {
  assert.equal(slugify(""), "untitled");
  assert.equal(slugify("!!!"), "untitled");
});

test("slugify caps slug length", () => {
  const long = "a".repeat(200);
  assert.ok(slugify(long).length <= 80);
});

test("disambiguateSlug appends stable 8-char hash", () => {
  const a = disambiguateSlug("post", "https://example.com/post");
  const b = disambiguateSlug("post", "https://example.com/post");
  assert.equal(a, b);
  assert.match(a, /^post-[0-9a-f]{8}$/);

  const c = disambiguateSlug("post", "https://example.com/other");
  assert.notEqual(a, c);
});

// --- Path A web scraper ---

const NO_LIGHTPANDA = { resolveLightpandaImpl: async () => null };

function makeFakeFetch({ body = "", status = 200, statusText = "OK", contentType = "text/html; charset=utf-8" } = {}) {
  return async () =>
    new Response(body, {
      status,
      statusText,
      headers: { "content-type": contentType }
    });
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-ingest-"));
  return {
    root,
    rawDir: path.join(root, "vault", "raw"),
    assetsDir: path.join(root, "vault", "assets"),
    eventsPath: path.join(root, "memory", "events.jsonl")
  };
}

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

function writePdfFixture(workspaceRoot, name, message) {
  const filePath = path.join(workspaceRoot, name);
  fs.writeFileSync(filePath, buildMinimalPdf(message));
  return filePath;
}

function makeMockSpawn(markdownOutput) {
  return async (_cmd, args) => {
    const outputDirIdx = args.indexOf("--output_dir");
    const outDir = args[outputDirIdx + 1];
    await fsp.mkdir(outDir, { recursive: true });
    await fsp.writeFile(path.join(outDir, "marker-output.md"), markdownOutput);
  };
}

function sameTitleHtml(title = "Same Title") {
  return `<!doctype html>
<html>
  <head><title>${title}</title></head>
  <body>
    <article>
      <h1>${title}</h1>
      <p>${"Readable article body. ".repeat(80)}</p>
    </article>
  </body>
</html>`;
}

async function readEvents(eventsPath) {
  try {
    const content = await fsp.readFile(eventsPath, "utf8");
    return content.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

test("ingestUrl writes markdown with frontmatter from HTML fixture", async () => {
  const ws = makeWorkspace();
  const html = await fsp.readFile(path.join(fixturesDir, "sample-article.html"), "utf8");
  const fetchImpl = makeFakeFetch({ body: html });

  const result = await ingestUrl("https://example.com/post?utm_source=feed#frag", {
    rawDir: ws.rawDir,
    eventsPath: ws.eventsPath,
    fetchImpl,
    ...NO_LIGHTPANDA,
    now: () => new Date("2026-05-10T12:00:00Z")
  });

  assert.equal(result.action, "written");
  assert.equal(result.kind, "web");
  assert.equal(result.parser, "readability+turndown");
  assert.equal(result.canonical, "https://example.com/post");
  assert.match(result.slug, /universal-knowledge-router/);

  const written = await fsp.readFile(result.destination, "utf8");
  assert.match(written, /^---\n/);
  assert.match(written, /\nsource: https:\/\/example\.com\/post\n/);
  assert.match(written, /\nkind: web\n/);
  assert.match(written, /\nparser: readability\+turndown\n/);
  assert.match(written, /Universal Knowledge Router/);
  assert.match(written, /Why markdown/);
  // Pre-clean removed nav/footer/aside/script content
  assert.ok(!written.includes("tracker beacon"));
  assert.ok(!written.includes("Recent posts"));

  const events = await readEvents(ws.eventsPath);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "ingest");
  assert.equal(events[0].kind, "web");
  assert.equal(events[0].parser, "readability+turndown");
  assert.equal(events[0].source, "https://example.com/post");
});

test("ingestUrl skips when destination already exists without overwrite", async () => {
  const ws = makeWorkspace();
  const html = await fsp.readFile(path.join(fixturesDir, "sample-article.html"), "utf8");
  const fetchImpl = makeFakeFetch({ body: html });
  const opts = { rawDir: ws.rawDir, eventsPath: ws.eventsPath, fetchImpl, ...NO_LIGHTPANDA };

  await ingestUrl("https://example.com/post", opts);
  const second = await ingestUrl("https://example.com/post", opts);

  assert.equal(second.action, "skipped");
  const events = await readEvents(ws.eventsPath);
  assert.equal(events.length, 1, "skipped run should not append a second event");
});

test("ingestUrl overwrites when overwrite=true", async () => {
  const ws = makeWorkspace();
  const html = await fsp.readFile(path.join(fixturesDir, "sample-article.html"), "utf8");
  const fetchImpl = makeFakeFetch({ body: html });
  const opts = { rawDir: ws.rawDir, eventsPath: ws.eventsPath, fetchImpl, ...NO_LIGHTPANDA };

  await ingestUrl("https://example.com/post", opts);
  const second = await ingestUrl("https://example.com/post", { ...opts, overwrite: true });

  assert.equal(second.action, "written");
  const events = await readEvents(ws.eventsPath);
  assert.equal(events.length, 2);
});

test("ingestUrl disambiguates duplicate titles from different URLs", async () => {
  const ws = makeWorkspace();
  const fetchImpl = makeFakeFetch({ body: sameTitleHtml("Shared Title") });
  const opts = { rawDir: ws.rawDir, eventsPath: ws.eventsPath, fetchImpl, ...NO_LIGHTPANDA };

  const first = await ingestUrl("https://example.com/a", opts);
  const second = await ingestUrl("https://example.org/b", opts);

  assert.equal(first.action, "written");
  assert.equal(second.action, "written");
  assert.notEqual(second.destination, first.destination);
  assert.match(path.basename(second.destination), /^shared-title-[0-9a-f]{8}\.md$/);

  const events = await readEvents(ws.eventsPath);
  assert.equal(events.length, 2);
});

test("ingestUrl --dry-run does not fetch or write", async () => {
  const ws = makeWorkspace();
  let fetched = false;
  const fetchImpl = async () => {
    fetched = true;
    return new Response("", { status: 200, headers: { "content-type": "text/html" } });
  };

  const result = await ingestUrl("https://example.com/post?utm_source=x", {
    rawDir: ws.rawDir,
    eventsPath: ws.eventsPath,
    fetchImpl,
    ...NO_LIGHTPANDA,
    dryRun: true
  });

  assert.equal(result.action, "dry-run");
  assert.equal(result.canonical, "https://example.com/post");
  assert.equal(fetched, false);
  assert.equal(fs.existsSync(ws.rawDir), false);
});

test("ingestUrl raises FETCH_FAILED on non-2xx responses", async () => {
  const ws = makeWorkspace();
  const fetchImpl = makeFakeFetch({ body: "not found", status: 404, statusText: "Not Found" });
  await assert.rejects(
    () =>
      ingestUrl("https://example.com/missing", {
        rawDir: ws.rawDir,
        eventsPath: ws.eventsPath,
        fetchImpl,
        ...NO_LIGHTPANDA
      }),
    (err) => err instanceof IngestError && err.code === "FETCH_FAILED"
  );
});

test("ingestUrl routes URL PDFs through Path B with URL source preserved", async () => {
  const ws = makeWorkspace();
  const pdfBody = buildMinimalPdf("URL PDF Body");
  const fetchImpl = makeFakeFetch({ body: pdfBody, contentType: "application/pdf" });

  const result = await ingestUrl("https://example.com/paper.pdf?utm_source=news", {
    rawDir: ws.rawDir,
    assetsDir: ws.assetsDir,
    eventsPath: ws.eventsPath,
    fetchImpl,
    ...NO_LIGHTPANDA,
    documentOptions: {
      whichImpl: async () => null,
      extractPdfImpl: async (sourcePath) => {
        assert.equal(fs.existsSync(sourcePath), true, "URL PDF should be downloaded to a temp file");
        return "Extracted URL PDF text.";
      }
    }
  });

  assert.equal(result.action, "written");
  assert.equal(result.kind, "pdf");
  assert.equal(result.parser, "unpdf");
  assert.equal(result.canonical, "https://example.com/paper.pdf");
  assert.equal(path.basename(result.asset), "paper.pdf");

  const written = await fsp.readFile(result.destination, "utf8");
  assert.match(written, /\nsource: https:\/\/example\.com\/paper\.pdf\n/);
  assert.match(written, /Extracted URL PDF text\./);

  const events = await readEvents(ws.eventsPath);
  assert.equal(events[0].source, "https://example.com/paper.pdf");
  assert.equal(events[0].asset, result.asset);
});

test("ingestUrl raises READABILITY_NULL on empty SPA shell (no silent body-dump)", async () => {
  const ws = makeWorkspace();
  const html = await fsp.readFile(path.join(fixturesDir, "sample-empty.html"), "utf8");
  const fetchImpl = makeFakeFetch({ body: html });
  await assert.rejects(
    () =>
      ingestUrl("https://example.com/spa", {
        rawDir: ws.rawDir,
        eventsPath: ws.eventsPath,
        fetchImpl,
        ...NO_LIGHTPANDA
      }),
    (err) => err instanceof IngestError && err.code === "READABILITY_NULL"
  );
  assert.equal(fs.existsSync(ws.rawDir) && fs.readdirSync(ws.rawDir).length > 0, false, "no file should be written");
});

// A consent wall parses into a valid, non-empty article, so READABILITY_NULL
// never fires and the boilerplate reaches the vault wearing the real page's
// title and URL. 29 captures in the wild were saved this way.
test("ingestUrl raises EXTRACTION_BLOCKED on a cookie-consent wall (no silent save)", async () => {
  const ws = makeWorkspace();
  const html = await fsp.readFile(path.join(fixturesDir, "sample-consent-wall.html"), "utf8");
  const fetchImpl = makeFakeFetch({ body: html });
  await assert.rejects(
    () =>
      ingestUrl("https://x.com/amasad/status/2077802290304684404", {
        rawDir: ws.rawDir,
        eventsPath: ws.eventsPath,
        fetchImpl,
        ...NO_LIGHTPANDA
      }),
    (err) => err instanceof IngestError && err.code === "EXTRACTION_BLOCKED"
  );
  assert.equal(fs.existsSync(ws.rawDir) && fs.readdirSync(ws.rawDir).length > 0, false, "no file should be written");
});

test("detectBlockedExtraction flags known walls and shells but spares short real captures", () => {
  assert.ok(detectBlockedExtraction("X and its partners use cookies to provide you"));
  assert.ok(detectBlockedExtraction("Did someone say … cookies?"));
  assert.ok(detectBlockedExtraction("If playback doesn't begin shortly, try restarting your device."));
  assert.ok(detectBlockedExtraction("If playback doesn’t begin shortly, try restarting your device."));
  assert.ok(detectBlockedExtraction("Your browser can't play this video"));
  assert.ok(detectBlockedExtraction("Drop files here to upload"));
  assert.ok(detectBlockedExtraction("Join Filippo Costa on Substack"));
  assert.ok(detectBlockedExtraction("Filippo Costa shared this with you."));

  // A real 452-byte capture from the wild. Any byte floor able to catch the
  // 480-byte Garry Tan wall would have discarded this, which is why the guard
  // matches signatures instead of length.
  assert.equal(
    detectBlockedExtraction("Anson Lin (@ansonlin) on X\n\nthe best founders I know all share one trait: they ship before they feel ready."),
    null
  );
  assert.equal(detectBlockedExtraction(""), null);
});

// Readability puts the YouTube wall's words in article.title and nothing
// identifying in the body, so a guard reading only the body never fires on the
// one capture the YouTube signature exists to catch.
test("detectBlockedExtraction reads the title, not only the body", () => {
  const body = "Sign in to confirm your choices\n\nWe use cookies and data to deliver and maintain Google services.";
  assert.equal(detectBlockedExtraction(body), null, "the body alone does not identify this wall");
  assert.ok(
    detectBlockedExtraction(body, "Before you continue to YouTube"),
    "the wall is only identifiable from the title"
  );
});

test("detectBlockedExtraction ignores a banner quoted deep inside a real article", () => {
  const article = `${"An analysis of consent design across major platforms. ".repeat(40)}
As the banner itself puts it: X and its partners use cookies to provide you with a better service.
${"The regulatory picture continues to shift. ".repeat(40)}`;
  assert.equal(detectBlockedExtraction(article, "Consent dark patterns, reviewed"), null);
});

test("detectBlockedExtraction does not treat ordinary English as a wall", () => {
  assert.equal(
    detectBlockedExtraction("These brown-butter chocolate chunk cookies are the best thing I baked this year.", "Did someone say cookies?"),
    null,
    "the wall says 'Did someone say … cookies?' with an ellipsis; the plain sentence is ordinary English"
  );
});

// The guard runs on markup fetched from an arbitrary remote host, so a pattern
// that backtracks on adversarial whitespace is a denial of service.
test("detectBlockedExtraction is not vulnerable to adversarial whitespace", () => {
  const hostile = `Did someone say${" ".repeat(400_000)}cookies?`;
  const started = process.hrtime.bigint();
  detectBlockedExtraction(hostile);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `guard took ${elapsedMs.toFixed(0)}ms on hostile input`);
});

// --- Path B document parser ---

test("detectMarker returns null when which fails", async () => {
  const result = await detectMarker(async () => {
    throw new Error("not found");
  });
  assert.equal(result, null);
});

test("detectMarker returns the resolved path when which succeeds", async () => {
  const result = await detectMarker(async () => "/usr/local/bin/marker_single");
  assert.equal(result, "/usr/local/bin/marker_single");
});

test("ingestDocument uses marker-local when marker is present (.pdf)", async () => {
  const ws = makeWorkspace();
  const pdfPath = writePdfFixture(ws.root, "report.pdf", "Marker would parse this");

  const result = await ingestDocument(pdfPath, {
    rawDir: ws.rawDir,
    assetsDir: ws.assetsDir,
    eventsPath: ws.eventsPath,
    whichImpl: async () => "/fake/marker_single",
    spawnImpl: makeMockSpawn("# Report\n\nMarker output text.\n"),
    now: () => new Date("2026-05-10T12:00:00Z")
  });

  assert.equal(result.action, "written");
  assert.equal(result.parser, "marker-local");
  assert.equal(result.kind, "pdf");

  const written = await fsp.readFile(result.destination, "utf8");
  assert.match(written, /\nparser: marker-local\n/);
  assert.match(written, /Marker output text\./);

  assert.equal(fs.existsSync(result.asset), true, "asset copy must exist");
});

test("ingestDocument uses marker-local for .docx when marker is present", async () => {
  const ws = makeWorkspace();
  const docxPath = path.join(ws.root, "memo.docx");
  await fsp.writeFile(docxPath, "PKfake-docx");

  const result = await ingestDocument(docxPath, {
    rawDir: ws.rawDir,
    assetsDir: ws.assetsDir,
    eventsPath: ws.eventsPath,
    whichImpl: async () => "/fake/marker_single",
    spawnImpl: makeMockSpawn("# Memo\n\nMarker rendered docx body.\n")
  });

  assert.equal(result.action, "written");
  assert.equal(result.parser, "marker-local");
  assert.equal(result.kind, "document");
  const events = await readEvents(ws.eventsPath);
  assert.equal(events[0].kind, "document");
  assert.equal(events[0].parser, "marker-local");
});

test("ingestDocument falls back to unpdf for .pdf when marker is absent", async () => {
  const ws = makeWorkspace();
  const pdfPath = writePdfFixture(ws.root, "paper.pdf", "Fallback path");
  let extracted = false;

  const result = await ingestDocument(pdfPath, {
    rawDir: ws.rawDir,
    assetsDir: ws.assetsDir,
    eventsPath: ws.eventsPath,
    whichImpl: async () => null,
    extractPdfImpl: async (sourcePath) => {
      extracted = true;
      assert.equal(sourcePath, pdfPath);
      return "Extracted plain text from PDF.";
    }
  });

  assert.equal(extracted, true);
  assert.equal(result.action, "written");
  assert.equal(result.parser, "unpdf");
  assert.equal(result.kind, "pdf");
  assert.match(result.warning || "", /basic text extraction/);

  const written = await fsp.readFile(result.destination, "utf8");
  assert.match(written, /\nparser: unpdf\n/);
  assert.match(written, /Extracted plain text from PDF\./);
});

test("ingestDocument raises MARKER_REQUIRED for .docx when marker is absent", async () => {
  const ws = makeWorkspace();
  const docxPath = path.join(ws.root, "memo.docx");
  await fsp.writeFile(docxPath, "PKfake");

  await assert.rejects(
    () =>
      ingestDocument(docxPath, {
        rawDir: ws.rawDir,
        assetsDir: ws.assetsDir,
        eventsPath: ws.eventsPath,
        whichImpl: async () => null
      }),
    (err) => err instanceof IngestError && err.code === "MARKER_REQUIRED"
  );

  assert.equal(fs.existsSync(ws.rawDir), false, "no raw output should be written");
  assert.equal(fs.existsSync(path.join(ws.assetsDir, "memo.docx")), true, "asset copy should be preserved before rejection");
});

test("ingestDocument always copies the original to vault/assets/", async () => {
  const ws = makeWorkspace();
  const pdfPath = writePdfFixture(ws.root, "preserve.pdf", "Asset preservation");

  const result = await ingestDocument(pdfPath, {
    rawDir: ws.rawDir,
    assetsDir: ws.assetsDir,
    eventsPath: ws.eventsPath,
    whichImpl: async () => null,
    extractPdfImpl: async () => "extracted"
  });

  const original = await fsp.readFile(pdfPath);
  const copied = await fsp.readFile(result.asset);
  assert.deepEqual(copied, original);
});

test("ingestDocument skips when destination exists without overwrite", async () => {
  const ws = makeWorkspace();
  const pdfPath = writePdfFixture(ws.root, "skip.pdf", "Skip me");
  const opts = {
    rawDir: ws.rawDir,
    assetsDir: ws.assetsDir,
    eventsPath: ws.eventsPath,
    whichImpl: async () => null,
    extractPdfImpl: async () => "first run"
  };

  await ingestDocument(pdfPath, opts);
  const second = await ingestDocument(pdfPath, opts);
  assert.equal(second.action, "skipped");

  const events = await readEvents(ws.eventsPath);
  assert.equal(events.length, 1);
});

test("ingestDocument disambiguates duplicate basenames from different sources", async () => {
  const ws = makeWorkspace();
  const oneDir = path.join(ws.root, "one");
  const twoDir = path.join(ws.root, "two");
  await fsp.mkdir(oneDir);
  await fsp.mkdir(twoDir);
  const firstPdf = writePdfFixture(oneDir, "report.pdf", "First PDF");
  const secondPdf = writePdfFixture(twoDir, "report.pdf", "Second PDF");
  const opts = {
    rawDir: ws.rawDir,
    assetsDir: ws.assetsDir,
    eventsPath: ws.eventsPath,
    whichImpl: async () => null,
    extractPdfImpl: async (sourcePath) => `extracted ${path.dirname(sourcePath)}`
  };

  const first = await ingestDocument(firstPdf, opts);
  const second = await ingestDocument(secondPdf, opts);

  assert.equal(first.action, "written");
  assert.equal(second.action, "written");
  assert.notEqual(first.destination, second.destination);
  assert.notEqual(first.asset, second.asset);
  assert.match(path.basename(second.destination), /^report-[0-9a-f]{8}\.md$/);
  assert.match(path.basename(second.asset), /^report-[0-9a-f]{8}\.pdf$/);

  const events = await readEvents(ws.eventsPath);
  assert.equal(events.length, 2);
});

test("ingestDocument --dry-run performs no I/O", async () => {
  const ws = makeWorkspace();
  const pdfPath = writePdfFixture(ws.root, "dry.pdf", "Should not parse");
  let calledExtract = false;
  let calledSpawn = false;

  const result = await ingestDocument(pdfPath, {
    rawDir: ws.rawDir,
    assetsDir: ws.assetsDir,
    eventsPath: ws.eventsPath,
    whichImpl: async () => "/fake/marker",
    spawnImpl: async () => {
      calledSpawn = true;
    },
    extractPdfImpl: async () => {
      calledExtract = true;
      return "x";
    },
    dryRun: true
  });

  assert.equal(result.action, "dry-run");
  assert.equal(result.parser, "marker-local|unpdf");
  assert.equal(calledSpawn, false);
  assert.equal(calledExtract, false);
  assert.equal(fs.existsSync(ws.rawDir), false);
  assert.equal(fs.existsSync(ws.assetsDir), false);
});

test("ingestDocument --dry-run does not require source file or marker detection", async () => {
  const ws = makeWorkspace();
  let calledWhich = false;
  const result = await ingestDocument(path.join(ws.root, "missing.pdf"), {
    rawDir: ws.rawDir,
    assetsDir: ws.assetsDir,
    eventsPath: ws.eventsPath,
    whichImpl: async () => {
      calledWhich = true;
      return "/fake/marker";
    },
    dryRun: true
  });

  assert.equal(result.action, "dry-run");
  assert.equal(result.parser, "marker-local|unpdf");
  assert.equal(calledWhich, false);
  assert.equal(fs.existsSync(ws.rawDir), false);
  assert.equal(fs.existsSync(ws.assetsDir), false);
});

test("ingestDocument raises FILE_NOT_FOUND for missing source", async () => {
  const ws = makeWorkspace();
  await assert.rejects(
    () =>
      ingestDocument(path.join(ws.root, "absent.pdf"), {
        rawDir: ws.rawDir,
        assetsDir: ws.assetsDir,
        eventsPath: ws.eventsPath,
        whichImpl: async () => null,
        extractPdfImpl: async () => "x"
      }),
    (err) => err instanceof IngestError && err.code === "FILE_NOT_FOUND"
  );
});

test("ingestDocument preserves asset when parser returns empty text", async () => {
  const ws = makeWorkspace();
  const pdfPath = writePdfFixture(ws.root, "empty.pdf", "Image only maybe");

  await assert.rejects(
    () =>
      ingestDocument(pdfPath, {
        rawDir: ws.rawDir,
        assetsDir: ws.assetsDir,
        eventsPath: ws.eventsPath,
        whichImpl: async () => null,
        extractPdfImpl: async () => ""
      }),
    (err) => err instanceof IngestError && err.code === "EMPTY_PARSE"
  );

  assert.equal(fs.existsSync(path.join(ws.assetsDir, "empty.pdf")), true);
  assert.equal(fs.existsSync(path.join(ws.rawDir, "empty.md")), false);
  const events = await readEvents(ws.eventsPath);
  assert.equal(events.length, 0);
});

test("ingestDocument extracts real text via unpdf default extractor", async () => {
  const ws = makeWorkspace();
  const pdfPath = writePdfFixture(ws.root, "real.pdf", "Hello DotAIOS Real");

  const result = await ingestDocument(pdfPath, {
    rawDir: ws.rawDir,
    assetsDir: ws.assetsDir,
    eventsPath: ws.eventsPath,
    whichImpl: async () => null
  });

  const written = await fsp.readFile(result.destination, "utf8");
  assert.match(written, /Hello DotAIOS Real/);
  assert.match(written, /\nparser: unpdf\n/);
});

// --- Path C text passthrough ---

test("ingestText wraps .txt with frontmatter", async () => {
  const ws = makeWorkspace();
  const src = path.join(ws.root, "note.txt");
  await fsp.writeFile(src, "Plain text body line one.\nLine two.\n");

  const result = await ingestText(src, {
    rawDir: ws.rawDir,
    eventsPath: ws.eventsPath,
    now: () => new Date("2026-05-10T12:00:00Z")
  });

  assert.equal(result.action, "written");
  assert.equal(result.parser, "copy");
  assert.equal(result.kind, "text");

  const written = await fsp.readFile(result.destination, "utf8");
  assert.match(written, /^---\n/);
  assert.match(written, /\nkind: text\n/);
  assert.match(written, /\nparser: copy\n/);
  assert.match(written, /\n---\n\nPlain text body line one\.\nLine two\.\n$/);
});

test("ingestText prepends frontmatter to .md without one", async () => {
  const ws = makeWorkspace();
  const src = path.join(ws.root, "bookmark.md");
  await fsp.writeFile(src, "# A markdown note\n\nBody.\n");

  const result = await ingestText(src, { rawDir: ws.rawDir, eventsPath: ws.eventsPath });
  const written = await fsp.readFile(result.destination, "utf8");
  assert.match(written, /^---\n/);
  assert.match(written, /\n# A markdown note\n/);
});

test("ingestText preserves existing frontmatter on .md", async () => {
  const ws = makeWorkspace();
  const src = path.join(ws.root, "preset.md");
  const original = "---\ntitle: existing\nkind: text\nparser: copy\nsource: x\ntags: []\n---\n\n# body\n";
  await fsp.writeFile(src, original);

  const result = await ingestText(src, { rawDir: ws.rawDir, eventsPath: ws.eventsPath });
  const written = await fsp.readFile(result.destination, "utf8");
  assert.equal(written, original);
});

test("ingestText fences .json and .csv content", async () => {
  const ws = makeWorkspace();
  const jsonPath = path.join(ws.root, "data.json");
  const csvPath = path.join(ws.root, "table.csv");
  await fsp.writeFile(jsonPath, `{"a":1,"b":2}`);
  await fsp.writeFile(csvPath, "col1,col2\n1,2\n3,4");

  const jsonResult = await ingestText(jsonPath, { rawDir: ws.rawDir, eventsPath: ws.eventsPath });
  const csvResult = await ingestText(csvPath, { rawDir: ws.rawDir, eventsPath: ws.eventsPath });

  const jsonOut = await fsp.readFile(jsonResult.destination, "utf8");
  const csvOut = await fsp.readFile(csvResult.destination, "utf8");

  assert.match(jsonOut, /```json\n\{"a":1,"b":2\}\n```/);
  assert.match(csvOut, /```csv\ncol1,col2\n1,2\n3,4\n```/);
});

test("ingestText skips when destination exists without overwrite", async () => {
  const ws = makeWorkspace();
  const src = path.join(ws.root, "skip.txt");
  await fsp.writeFile(src, "first");

  const opts = { rawDir: ws.rawDir, eventsPath: ws.eventsPath };
  await ingestText(src, opts);
  const second = await ingestText(src, opts);
  assert.equal(second.action, "skipped");
  const events = await readEvents(ws.eventsPath);
  assert.equal(events.length, 1);
});

test("ingestText disambiguates duplicate basenames from different sources", async () => {
  const ws = makeWorkspace();
  const oneDir = path.join(ws.root, "one");
  const twoDir = path.join(ws.root, "two");
  await fsp.mkdir(oneDir);
  await fsp.mkdir(twoDir);
  const firstPath = path.join(oneDir, "same.txt");
  const secondPath = path.join(twoDir, "same.txt");
  await fsp.writeFile(firstPath, "alpha");
  await fsp.writeFile(secondPath, "beta");

  const first = await ingestText(firstPath, { rawDir: ws.rawDir, eventsPath: ws.eventsPath });
  const second = await ingestText(secondPath, { rawDir: ws.rawDir, eventsPath: ws.eventsPath });

  assert.equal(first.action, "written");
  assert.equal(second.action, "written");
  assert.notEqual(first.destination, second.destination);
  assert.match(path.basename(second.destination), /^same-[0-9a-f]{8}\.md$/);
  assert.match(await fsp.readFile(second.destination, "utf8"), /beta/);

  const events = await readEvents(ws.eventsPath);
  assert.equal(events.length, 2);
});

test("ingestText --dry-run performs no writes", async () => {
  const ws = makeWorkspace();
  const src = path.join(ws.root, "dry.txt");
  await fsp.writeFile(src, "dry body");

  const result = await ingestText(src, {
    rawDir: ws.rawDir,
    eventsPath: ws.eventsPath,
    dryRun: true
  });
  assert.equal(result.action, "dry-run");
  assert.equal(fs.existsSync(ws.rawDir), false);
});

test("ingestText --dry-run does not require source file", async () => {
  const ws = makeWorkspace();
  const missing = path.join(ws.root, "missing.txt");
  const result = await ingestText(missing, {
    rawDir: ws.rawDir,
    eventsPath: ws.eventsPath,
    dryRun: true
  });

  assert.equal(result.action, "dry-run");
  assert.equal(result.canonical, missing);
  assert.equal(fs.existsSync(ws.rawDir), false);
});

test("ingestText raises FILE_NOT_FOUND for missing source", async () => {
  const ws = makeWorkspace();
  await assert.rejects(
    () =>
      ingestText(path.join(ws.root, "absent.txt"), {
        rawDir: ws.rawDir,
        eventsPath: ws.eventsPath
      }),
    (err) => err instanceof IngestError && err.code === "FILE_NOT_FOUND"
  );
});

// --- Path D binary fallthrough ---

test("ingestBinary copies unknown binary into vault/assets", async () => {
  const ws = makeWorkspace();
  const src = path.join(ws.root, "blob.bin");
  await fsp.writeFile(src, Buffer.from([0xde, 0xad, 0xbe, 0xef]));

  const result = await ingestBinary(src, {
    assetsDir: ws.assetsDir,
    eventsPath: ws.eventsPath
  });

  assert.equal(result.action, "written");
  assert.equal(result.parser, "copy");
  assert.equal(result.kind, "binary");
  assert.equal(fs.existsSync(result.asset), true);
  assert.equal(fs.existsSync(ws.rawDir), false, "binary path must not write to vault/raw");

  const events = await readEvents(ws.eventsPath);
  assert.equal(events[0].kind, "binary");
  assert.equal(events[0].parser, "copy");
});

test("ingestBinary preserves bytes verbatim", async () => {
  const ws = makeWorkspace();
  const src = path.join(ws.root, "blob.dmg");
  const payload = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
  await fsp.writeFile(src, payload);

  const result = await ingestBinary(src, {
    assetsDir: ws.assetsDir,
    eventsPath: ws.eventsPath
  });
  const copied = await fsp.readFile(result.asset);
  assert.deepEqual(copied, payload);
});

test("ingestBinary skips when asset exists without overwrite", async () => {
  const ws = makeWorkspace();
  const src = path.join(ws.root, "blob.zip");
  await fsp.writeFile(src, Buffer.from("contents"));

  const opts = { assetsDir: ws.assetsDir, eventsPath: ws.eventsPath };
  await ingestBinary(src, opts);
  const second = await ingestBinary(src, opts);
  assert.equal(second.action, "skipped");
  const events = await readEvents(ws.eventsPath);
  assert.equal(events.length, 1);
});

test("ingestBinary disambiguates duplicate filenames from different sources", async () => {
  const ws = makeWorkspace();
  const oneDir = path.join(ws.root, "one");
  const twoDir = path.join(ws.root, "two");
  await fsp.mkdir(oneDir);
  await fsp.mkdir(twoDir);
  const firstPath = path.join(oneDir, "same.bin");
  const secondPath = path.join(twoDir, "same.bin");
  await fsp.writeFile(firstPath, Buffer.from([1]));
  await fsp.writeFile(secondPath, Buffer.from([2]));

  const first = await ingestBinary(firstPath, { assetsDir: ws.assetsDir, eventsPath: ws.eventsPath });
  const second = await ingestBinary(secondPath, { assetsDir: ws.assetsDir, eventsPath: ws.eventsPath });

  assert.equal(first.action, "written");
  assert.equal(second.action, "written");
  assert.notEqual(first.asset, second.asset);
  assert.match(path.basename(second.asset), /^same-[0-9a-f]{8}\.bin$/);
  assert.deepEqual(await fsp.readFile(second.asset), Buffer.from([2]));

  const events = await readEvents(ws.eventsPath);
  assert.equal(events.length, 2);
});

test("ingestBinary --dry-run performs no copy", async () => {
  const ws = makeWorkspace();
  const src = path.join(ws.root, "dry.bin");
  await fsp.writeFile(src, Buffer.from("x"));
  const result = await ingestBinary(src, {
    assetsDir: ws.assetsDir,
    eventsPath: ws.eventsPath,
    dryRun: true
  });
  assert.equal(result.action, "dry-run");
  assert.equal(fs.existsSync(ws.assetsDir), false);
});

test("ingestBinary --dry-run does not require source file", async () => {
  const ws = makeWorkspace();
  const missing = path.join(ws.root, "missing.bin");
  const result = await ingestBinary(missing, {
    assetsDir: ws.assetsDir,
    eventsPath: ws.eventsPath,
    dryRun: true
  });

  assert.equal(result.action, "dry-run");
  assert.equal(result.canonical, missing);
  assert.equal(fs.existsSync(ws.assetsDir), false);
});

test("ingestBinary raises FILE_NOT_FOUND for missing source", async () => {
  const ws = makeWorkspace();
  await assert.rejects(
    () =>
      ingestBinary(path.join(ws.root, "absent.bin"), {
        assetsDir: ws.assetsDir,
        eventsPath: ws.eventsPath
      }),
    (err) => err instanceof IngestError && err.code === "FILE_NOT_FOUND"
  );
});

// --- Skill bridging into ~/.claude/skills/ ---

test("activate symlinks AIOS skills into ~/.claude/skills/ for slash-command discovery", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-v141-skills-"));
  const aiosPath = path.join(tempRoot, "aios");
  const homePath = path.join(tempRoot, "home");

  runCli(["init", "--path", aiosPath, "--yes"]);
  fs.mkdirSync(path.join(homePath, ".claude"), { recursive: true });
  runCli(["activate", "--path", aiosPath, "--home", homePath]);

  const claudeSkills = path.join(homePath, ".claude", "skills");
  assert.equal(fs.existsSync(claudeSkills), true, "~/.claude/skills/ should be created");

  for (const name of ["audit", "ingest", "plan-today", "today", "closeday", "import-context", "save-session"]) {
    const link = path.join(claudeSkills, name);
    assert.equal(fs.existsSync(link), true, `expected symlink at ${link}`);
    const stat = fs.lstatSync(link);
    assert.equal(stat.isSymbolicLink(), true, `${name} should be a symlink`);
    const target = fs.readlinkSync(link);
    assert.equal(target, path.join(aiosPath, "skills", name), `${name} should target the AIOS skill folder`);

    const skillFile = path.join(link, "SKILL.md");
    assert.equal(fs.existsSync(skillFile), true, `${skillFile} should resolve through the symlink`);
    const content = fs.readFileSync(skillFile, "utf8");
    assert.match(content, /^---\nname: /, `${name} SKILL.md should start with YAML frontmatter for Claude Code skill discovery`);
  }
});

test("init registry lists bundled save-session skill", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-v141-registry-"));
  const aiosPath = path.join(tempRoot, "aios");

  runCli(["init", "--path", aiosPath, "--yes"]);

  const result = runCli(["skill", "list", "--path", aiosPath]);
  assert.match(result.stdout, /save-session/);
});

test("every shipped skill has YAML frontmatter so Claude Code surfaces /skill commands", () => {
  const skillsRoot = path.join(repoRoot, "skills");
  const entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillsRoot, entry.name, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;
    const content = fs.readFileSync(skillPath, "utf8");
    assert.match(content, /^---\n/, `${entry.name}/SKILL.md must start with YAML frontmatter`);
    assert.match(content, /\nname:\s*\S+\n/, `${entry.name}/SKILL.md must declare a name field`);
    assert.match(content, /\ndescription:\s*\S+/, `${entry.name}/SKILL.md must declare a description field`);
  }
});

// --- Skill mirror ---

test("skills/ingest/SKILL.md mirrors the CLI surface", () => {
  const skillPath = path.join(repoRoot, "skills", "ingest", "SKILL.md");
  const content = fs.readFileSync(skillPath, "utf8");

  // All four routing paths must be documented.
  for (const label of ["Path A", "Path B", "Path C", "Path D"]) {
    assert.ok(content.includes(label) || content.match(new RegExp(`A — web scraper|B — document parser|C — text passthrough|D — binary fallthrough`)), `skill should describe routing paths (missing ${label})`);
  }
  assert.match(content, /web scraper/);
  assert.match(content, /document parser/);
  assert.match(content, /text passthrough/);
  assert.match(content, /binary fallthrough/);

  // All four CLI flags must be documented.
  for (const flag of ["--path", "--overwrite", "--dry-run", "--timeout"]) {
    assert.ok(content.includes(flag), `skill should document ${flag}`);
  }

  // Frontmatter schema fields.
  for (const field of ["source:", "ingested_at:", "kind:", "parser:", "title:", "tags:"]) {
    assert.ok(content.includes(field), `skill should list frontmatter field ${field}`);
  }

  // Marker install prompt must include the disk-cost disclosure.
  assert.match(content, /~2 GB/);
  assert.match(content, /marker-pdf/);

  // Privacy disclosure must be present and consistent with CLI --help.
  assert.match(content, /No content is uploaded to any cloud service/);

  // CLI is the routing authority.
  assert.match(content, /CLI is the routing authority|CLI wins/);
});

// --- CLI flags ---

test("ingest --help documents new flags and privacy disclosure", () => {
  const result = runCli(["ingest", "--help"]);
  assert.match(result.stdout, /--overwrite/);
  assert.match(result.stdout, /--dry-run/);
  assert.match(result.stdout, /--timeout/);
  assert.match(result.stdout, /No content is uploaded to any cloud service/);
  assert.match(result.stdout, /Dynamic or paywalled pages may ingest partial content/);
});

test("default AIOS path is visible ~/aios", () => {
  assert.equal(defaultAiosPath(), path.join(os.homedir(), "aios"));
});

test("ingest --dry-run on a text file prints plan and does not write", () => {
  const { aiosPath, tempRoot } = setupAiosWorkspace();
  const src = path.join(tempRoot, "draft.txt");
  fs.writeFileSync(src, "hello dry-run");

  const result = runCli(["ingest", src, "--path", aiosPath, "--dry-run"]);
  assert.match(result.stdout, /\[dry-run\] kind=text parser=copy/);
  assert.ok(result.stdout.includes(src), "plan should mention source");
  assert.equal(fs.existsSync(path.join(aiosPath, "vault", "raw", "draft.md")), false);

  const events = fs.existsSync(path.join(aiosPath, "memory", "events.jsonl"))
    ? fs.readFileSync(path.join(aiosPath, "memory", "events.jsonl"), "utf8")
    : "";
  assert.equal(events.includes('"type":"ingest"'), false);
});

test("ingest --dry-run on a binary file prints asset target", () => {
  const { aiosPath, tempRoot } = setupAiosWorkspace();
  const src = path.join(tempRoot, "blob.bin");
  fs.writeFileSync(src, Buffer.from([0xde, 0xad]));

  const result = runCli(["ingest", src, "--path", aiosPath, "--dry-run"]);
  assert.match(result.stdout, /\[dry-run\] kind=binary parser=copy/);
  assert.match(result.stdout, /asset:/);
  assert.equal(fs.existsSync(path.join(aiosPath, "vault", "assets", "blob.bin")), false);
});

test("ingest --dry-run on nonexistent local inputs performs no file I/O", () => {
  const { aiosPath, tempRoot } = setupAiosWorkspace();
  const missingPdf = path.join(tempRoot, "missing.pdf");
  const missingTxt = path.join(tempRoot, "missing.txt");
  const missingBin = path.join(tempRoot, "missing.bin");

  const pdf = runCli(["ingest", missingPdf, "--path", aiosPath, "--dry-run"]);
  assert.match(pdf.stdout, /\[dry-run\] kind=pdf parser=marker-local\|unpdf/);

  const txt = runCli(["ingest", missingTxt, "--path", aiosPath, "--dry-run"]);
  assert.match(txt.stdout, /\[dry-run\] kind=text parser=copy/);

  const bin = runCli(["ingest", missingBin, "--path", aiosPath, "--dry-run"]);
  assert.match(bin.stdout, /\[dry-run\] kind=binary parser=copy/);

  assert.equal(fs.existsSync(path.join(aiosPath, "vault", "raw", "missing.md")), false);
  assert.equal(fs.existsSync(path.join(aiosPath, "vault", "assets", "missing.pdf")), false);
  assert.equal(fs.existsSync(path.join(aiosPath, "vault", "assets", "missing.bin")), false);
});

test("ingest skips an existing destination by default and overwrites with --overwrite", () => {
  const { aiosPath, tempRoot } = setupAiosWorkspace();
  const src = path.join(tempRoot, "memo.txt");
  fs.writeFileSync(src, "memo body");

  runCli(["ingest", src, "--path", aiosPath]);
  const second = runCli(["ingest", src, "--path", aiosPath]);
  assert.match(second.stdout, /Already ingested:/);

  const eventsPath = path.join(aiosPath, "memory", "events.jsonl");
  const beforeOverwriteCount = fs
    .readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter(Boolean).length;

  const overwrite = runCli(["ingest", src, "--path", aiosPath, "--overwrite"]);
  assert.match(overwrite.stdout, /Ingested /);

  const afterOverwriteCount = fs
    .readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter(Boolean).length;
  assert.equal(afterOverwriteCount, beforeOverwriteCount + 1);
});

test("ingest --timeout rejects non-positive values", () => {
  const { aiosPath, tempRoot } = setupAiosWorkspace();
  const src = path.join(tempRoot, "x.txt");
  fs.writeFileSync(src, "x");

  const fail = runCli(["ingest", "https://example.com", "--path", aiosPath, "--timeout", "abc"], {
    expectFail: true
  });
  assert.match(fail.stderr, /--timeout must be a positive number of seconds/);

  const failZero = runCli(["ingest", "https://example.com", "--path", aiosPath, "--timeout", "0"], {
    expectFail: true
  });
  assert.match(failZero.stderr, /--timeout must be a positive number of seconds/);
});

test("ingest --overwrite is a no-op flag without a value", () => {
  const { aiosPath, tempRoot } = setupAiosWorkspace();
  const src = path.join(tempRoot, "first.txt");
  fs.writeFileSync(src, "body");
  // Place --overwrite before the path positional to confirm it does not consume the next arg.
  runCli(["ingest", src, "--overwrite", "--path", aiosPath]);
  assert.equal(fs.existsSync(path.join(aiosPath, "vault", "raw", "first.md")), true);
});

test("ingestUrl raises TIMEOUT when fetch is aborted", async () => {
  const ws = makeWorkspace();
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  await assert.rejects(
    () =>
      ingestUrl("https://example.com/slow", {
        rawDir: ws.rawDir,
        eventsPath: ws.eventsPath,
        fetchImpl,
        ...NO_LIGHTPANDA,
        timeoutMs: 30
      }),
    (err) => err instanceof IngestError && err.code === "TIMEOUT"
  );
});
