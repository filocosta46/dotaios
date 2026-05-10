import fs from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "../../../core/src/memory.mjs";
import { resolveAssetDestination } from "./destinations.mjs";
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
  const fileName = path.basename(sourcePath);
  const assetDest = path.join(assetsDir, fileName);

  if (dryRun) {
    return {
      action: "dry-run",
      kind: "binary",
      parser: "copy",
      canonical: sourcePath,
      plan: { kind: "binary", parser: "copy", source: sourcePath, asset: assetDest }
    };
  }

  await assertExists(sourcePath);

  const target = await resolveAssetDestination({
    assetsDir,
    fileName,
    source: sourcePath,
    eventsPath,
    overwrite
  });
  if (target.action === "skip") {
    return { action: "skipped", asset: target.asset, parser: "copy", kind: "binary", canonical: sourcePath };
  }

  await fs.mkdir(assetsDir, { recursive: true });
  await fs.copyFile(sourcePath, target.asset);

  await appendEvent(eventsPath, {
    type: "ingest",
    source: sourcePath,
    asset: target.asset,
    kind: "binary",
    parser: "copy",
    summary: fileName
  });

  return { action: "written", asset: target.asset, parser: "copy", kind: "binary", canonical: sourcePath };
}

async function assertExists(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    throw new IngestError(`File not found: ${filePath}`, "FILE_NOT_FOUND");
  }
}
