import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const INVOCATION_RECEIPT_SCHEMA = "dotaios.skill-invocation.v1";

const CONFIGURED = new Set(["yes", "no", "not-detected", "unknown"]);
const DISCOVERABLE = new Set(["path-ready", "no", "not-detected", "unknown"]);
const OBSERVED = new Set(["yes", "no", "not-run", "unknown"]);

/**
 * Build the small, portable evidence record shared by every client probe.
 *
 * The record intentionally keeps configuration, discovery, invocation, and
 * output production separate. A path can be configured without being
 * discoverable, and a client can be invoked without proving that it used the
 * requested skill.
 */
export function createInvocationReceipt({
  client,
  clientVersion = null,
  configured = "unknown",
  discoverable = "unknown",
  invoked = "not-run",
  produced = "not-run",
  targetPath = null,
  skillName = null,
  skillPath = null,
  skillDigest = null,
  command = null,
  marker = null,
  exitCode = null,
  limitation = null,
  error = null,
  startedAt = null,
  finishedAt = null
}) {
  if (!client || typeof client !== "string") {
    throw new TypeError("client is required");
  }
  assertValue(CONFIGURED, configured, "configured");
  assertValue(DISCOVERABLE, discoverable, "discoverable");
  assertValue(OBSERVED, invoked, "invoked");
  assertValue(OBSERVED, produced, "produced");

  return {
    schema: INVOCATION_RECEIPT_SCHEMA,
    client,
    clientVersion,
    targetPath,
    skill: {
      name: skillName,
      path: skillPath,
      sha256: skillDigest
    },
    evidence: {
      configured,
      discoverable,
      invoked,
      produced
    },
    command: Array.isArray(command) ? [...command] : command,
    marker,
    exitCode,
    limitation,
    error,
    startedAt,
    finishedAt
  };
}

export function markerWasProduced(output, marker) {
  if (!marker || typeof output !== "string") return false;
  return output.split(/\r?\n/).some((line) => line.trim() === marker);
}

export async function sha256File(filePath) {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export async function writeInvocationReceipt(receiptPath, receipt) {
  const destination = path.resolve(receiptPath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return destination;
}

function assertValue(allowed, value, field) {
  if (!allowed.has(value)) {
    throw new TypeError(`${field} must be one of: ${[...allowed].join(", ")}`);
  }
}
