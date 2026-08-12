import fs from "node:fs/promises";
import path from "node:path";
import { readJsonl } from "../../../core/src/memory.mjs";
import { disambiguateSlug } from "./frontmatter.mjs";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export async function resolveMarkdownDestination({ rawDir, baseSlug, source, overwrite = false }) {
  const primary = path.join(rawDir, `${baseSlug}.md`);
  const first = await inspectMarkdownDestination(primary, source);

  if (!first.exists) {
    return { destination: primary, slug: baseSlug, action: "write" };
  }

  if (first.sameSource) {
    return overwrite
      ? { destination: primary, slug: baseSlug, action: "write" }
      : { destination: primary, slug: baseSlug, action: "skip" };
  }

  const hashedSlug = disambiguateSlug(baseSlug, source);
  return await resolveHashedMarkdownDestination({ rawDir, hashedSlug, source, overwrite });
}

async function resolveHashedMarkdownDestination({ rawDir, hashedSlug, source, overwrite }) {
  for (let index = 0; index < 1000; index += 1) {
    const slug = index === 0 ? hashedSlug : `${hashedSlug}-${index + 1}`;
    const destination = path.join(rawDir, `${slug}.md`);
    const inspected = await inspectMarkdownDestination(destination, source);

    if (!inspected.exists) {
      return { destination, slug, action: "write" };
    }

    if (inspected.sameSource) {
      return overwrite
        ? { destination, slug, action: "write" }
        : { destination, slug, action: "skip" };
    }
  }

  throw new Error(`Could not resolve a unique destination for ${hashedSlug}`);
}

async function inspectMarkdownDestination(destination, source) {
  let content;
  try {
    content = await fs.readFile(destination, "utf8");
  } catch {
    return { exists: false, sameSource: false };
  }

  const existingSource = readFrontmatterSource(content);
  return {
    exists: true,
    sameSource: existingSource === source
  };
}

export async function resolveAssetDestination({ assetsDir, fileName, source, eventsPath, overwrite = false }) {
  const existingForSource = await findExistingAssetForSource({ eventsPath, source });
  if (existingForSource) {
    return overwrite
      ? { asset: existingForSource, action: "write" }
      : { asset: existingForSource, action: "skip" };
  }

  const primary = path.join(assetsDir, fileName);
  if (!await fileExists(primary)) {
    return { asset: primary, action: "write" };
  }

  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  const hashedStem = disambiguateSlug(stem, source);

  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const asset = path.join(assetsDir, `${hashedStem}${suffix}${ext}`);
    if (!await fileExists(asset)) {
      return { asset, action: "write" };
    }
  }

  throw new Error(`Could not resolve a unique asset destination for ${fileName}`);
}

export function readFrontmatterSource(content) {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;

  const sourceLine = match[1]
    .split(/\r?\n/)
    .find((line) => /^source:\s*/.test(line));
  if (!sourceLine) return null;

  return unquoteYaml(sourceLine.replace(/^source:\s*/, "").trim());
}

function unquoteYaml(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

async function findExistingAssetForSource({ eventsPath, source }) {
  const events = await readJsonl(eventsPath);
  for (const event of events.slice().reverse()) {
    if (event.type === "ingest" && event.source === source && event.asset) {
      return event.asset;
    }
  }
  return null;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
