import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { writeFileSafe } from "../../../core/src/files.mjs";
import { readContainedFile } from "../../../core/src/contained-read.mjs";
import { buildFrontmatter } from "./frontmatter.mjs";
import { extractArticle, PARSER_PLAIN } from "./web.mjs";

export async function ingestResearchSource(rawUrl, { workdir, timeoutMs } = {}, dependencies = {}) {
  if (!workdir) throw new Error("Research ingestion needs an explicit work folder.");
  const root = path.resolve(workdir);
  const initialRoot = await fs.lstat(root);
  if (!initialRoot.isDirectory() || initialRoot.isSymbolicLink()) throw workdirChanged();
  const realRoot = await fs.realpath(root);
  async function checkRoot() {
    const current = await fs.lstat(root).catch(() => null);
    if (!current || current.isSymbolicLink() || current.dev !== initialRoot.dev || current.ino !== initialRoot.ino
      || await fs.realpath(root) !== realRoot) throw workdirChanged();
  }
  const fetchSource = dependencies.fetchSource || (await import("./public-source.mjs")).fetchPublicSource;
  const fetched = await fetchSource(rawUrl, { timeoutMs });
  const id = digest(Buffer.concat([Buffer.from(`${fetched.url}\n`), fetched.body]));
  const isHtml = fetched.contentType === "text/html" || fetched.contentType === "application/xhtml+xml";
  const originalPath = `research/sources/${id}.${isHtml ? "html" : "txt"}`;
  const sourcePath = `research/sources/${id}.md`;
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(fetched.body);
    if (!content.trim()) throw new Error("Empty source");
  } catch {
    throw Object.assign(new Error("Research source has no readable UTF-8 text. No artifacts were saved."),
      { code: "RESEARCH_TEXT_UNREADABLE" });
  }
  let article;
  try {
    article = isHtml ? await extractArticle(content, fetched.url) : { title: fetched.url, markdown: content };
  } catch {
    throw Object.assign(new Error("This HTML source could not be extracted. Try the publisher's plain-text version or another supported source. No artifacts were saved."),
      { code: "RESEARCH_EXTRACTION_FAILED" });
  }
  await checkRoot();
  const original = await preserveExact(root, originalPath, fetched.body);
  const frontmatter = buildFrontmatter({
    source: fetched.url, kind: "web", parser: isHtml ? PARSER_PLAIN : "plain-text", title: article.title,
    ingestedAt: new Date(original.stats.mtimeMs).toISOString()
  });
  const markdown = Buffer.from(`${frontmatter}\n${article.markdown.trimEnd()}\n`);
  await checkRoot();
  await preserveExact(root, sourcePath, markdown);
  await checkRoot();
  return {
    status: "captured", requestedUrl: fetched.requestedUrl,
    original: { path: originalPath, sha256: digest(fetched.body), bytes: fetched.body.length },
    source: { path: sourcePath, origin: fetched.url, sha256: digest(markdown), bytes: markdown.length }
  };
}

function workdirChanged() {
  return Object.assign(new Error("The research work folder is unavailable or changed. Re-identify it before continuing."),
    { code: "RESEARCH_WORKDIR_CHANGED" });
}

async function preserveExact(root, relative, bytes) {
  const destination = path.join(root, relative);
  await writeFileSafe(destination, bytes, "preserve", { boundaryRoot: root });
  const observed = await readContainedFile(root, destination, { maxBytes: 4 * 1024 * 1024, returnSnapshot: true });
  if (!observed || !observed.content.equals(bytes)) {
    const error = new Error("A retained research artifact changed. Preserve it and inspect the current work before continuing.");
    error.code = "RESEARCH_SOURCE_CHANGED";
    throw error;
  }
  return observed;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
