import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const ingestDir = path.resolve(
  new URL("../../packages/cli/src/ingest/", import.meta.url).pathname
);

const { classifyInput, isUrl } = await import(path.join(ingestDir, "route.mjs"));
const { canonicalizeUrl } = await import(path.join(ingestDir, "canonical-url.mjs"));
const {
  buildFrontmatter,
  ensureFrontmatter,
  slugify,
  disambiguateSlug
} = await import(path.join(ingestDir, "frontmatter.mjs"));

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
