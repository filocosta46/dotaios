import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

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
const { ingestUrl, IngestError } = await import(path.join(ingestDir, "web.mjs"));

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
    eventsPath: path.join(root, "memory", "events.jsonl")
  };
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
  const opts = { rawDir: ws.rawDir, eventsPath: ws.eventsPath, fetchImpl };

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
  const opts = { rawDir: ws.rawDir, eventsPath: ws.eventsPath, fetchImpl };

  await ingestUrl("https://example.com/post", opts);
  const second = await ingestUrl("https://example.com/post", { ...opts, overwrite: true });

  assert.equal(second.action, "written");
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
        fetchImpl
      }),
    (err) => err instanceof IngestError && err.code === "FETCH_FAILED"
  );
});

test("ingestUrl raises PDF_CONTENT_TYPE when URL serves a PDF", async () => {
  const ws = makeWorkspace();
  const fetchImpl = makeFakeFetch({ body: "%PDF-1.4", contentType: "application/pdf" });
  await assert.rejects(
    () =>
      ingestUrl("https://example.com/paper.pdf", {
        rawDir: ws.rawDir,
        eventsPath: ws.eventsPath,
        fetchImpl
      }),
    (err) => err instanceof IngestError && err.code === "PDF_CONTENT_TYPE"
  );
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
        fetchImpl
      }),
    (err) => err instanceof IngestError && err.code === "READABILITY_NULL"
  );
  assert.equal(fs.existsSync(ws.rawDir) && fs.readdirSync(ws.rawDir).length > 0, false, "no file should be written");
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
        timeoutMs: 30
      }),
    (err) => err instanceof IngestError && err.code === "TIMEOUT"
  );
});
