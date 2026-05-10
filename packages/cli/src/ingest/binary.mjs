import fs from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "../../../core/src/memory.mjs";
import { disambiguateSlug } from "./frontmatter.mjs";
import { IngestError } from "./web.mjs";

/**
 * Path D: copy an unknown binary into vault/assets/ untouched.
 *
 * No markdown is written. No parse attempt. The audit trail captures
 * kind:binary, parser:copy.
 *
 * @returns {Promise<{action:"written"|"skipped"|"dry-run", asset?:string, parser:"copy", kind:"binary", canonical:string, plan?:object}>}
 */
export async function ingestBinary(rawInput, options) {
  if (!options || !options.assetsDir || !options.eventsPath) {
    throw new Error("ingestBinary requires options.assetsDir and options.eventsPath");
  }
  const {
    assetsDir,
    eventsPath,
    overwrite = false,
    dryRun = false
  } = options;

  const sourcePath = path.resolve(rawInput);
  await assertExists(sourcePath);

  const fileName = path.basename(sourcePath);
  let assetDest = path.join(assetsDir, fileName);

  if (dryRun) {
    return {
      action: "dry-run",
      kind: "binary",
      parser: "copy",
      canonical: sourcePath,
      plan: { kind: "binary", parser: "copy", source: sourcePath, asset: assetDest }
    };
  }

  if (await fileExists(assetDest) && !overwrite) {
    return { action: "skipped", asset: assetDest, parser: "copy", kind: "binary", canonical: sourcePath };
  }

  // Disambiguate filename collision against an unrelated earlier ingest.
  if (!(await fileExists(assetDest))) {
    let probe = assetDest;
    if (await fileExists(probe)) {
      const ext = path.extname(fileName);
      const stem = path.basename(fileName, ext);
      const newName = `${disambiguateSlug(stem, sourcePath)}${ext}`;
      probe = path.join(assetsDir, newName);
    }
    assetDest = probe;
  }

  await fs.mkdir(assetsDir, { recursive: true });
  await fs.copyFile(sourcePath, assetDest);

  await appendEvent(eventsPath, {
    type: "ingest",
    source: sourcePath,
    asset: assetDest,
    kind: "binary",
    parser: "copy",
    summary: fileName
  });

  return { action: "written", asset: assetDest, parser: "copy", kind: "binary", canonical: sourcePath };
}

async function assertExists(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    throw new IngestError(`File not found: ${filePath}`, "FILE_NOT_FOUND");
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
