import fs from "node:fs/promises";
import readline from "node:readline/promises";
import { pathExists } from "./files.mjs";

const MAX_PREVIEW_LINES = 40;

export const Action = Object.freeze({
  Create: "create",
  Update: "update",
  NoChange: "no change"
});

export async function previewWrite({ path: target, content }) {
  const exists = await pathExists(target);
  const current = exists ? await fs.readFile(target, "utf8") : "";
  const action = !exists ? Action.Create : current === content ? Action.NoChange : Action.Update;
  return { path: target, action, current, next: content };
}

export function renderPreview(preview) {
  if (preview.action === Action.NoChange) {
    return `[${preview.action}] ${preview.path}`;
  }
  if (preview.action === Action.Create) {
    return renderCreate(preview);
  }
  return renderUpdate(preview);
}

function renderCreate(preview) {
  const body = preview.next.split("\n");
  const lines = [`[${preview.action}] ${preview.path}`, `  +++ ${body.length} line(s)`];
  for (const line of body.slice(0, MAX_PREVIEW_LINES)) lines.push(`  + ${line}`);
  if (body.length > MAX_PREVIEW_LINES) lines.push(`  ... (${body.length - MAX_PREVIEW_LINES} more)`);
  return lines.join("\n");
}

function renderUpdate(preview) {
  const before = preview.current.split("\n");
  const after = preview.next.split("\n");
  const lines = [
    `[${preview.action}] ${preview.path}`,
    `  --- ${before.length} line(s)`,
    `  +++ ${after.length} line(s)`
  ];
  for (const line of after.slice(0, MAX_PREVIEW_LINES)) lines.push(`  | ${line}`);
  if (after.length > MAX_PREVIEW_LINES) lines.push(`  ... (${after.length - MAX_PREVIEW_LINES} more)`);
  return lines.join("\n");
}

export async function confirmWrites(plan, {
  autoApprove = false,
  input = process.stdin,
  output = process.stdout,
  log = console
} = {}) {
  if (plan.length === 0) return true;

  const previews = await Promise.all(plan.map(previewWrite));
  const changed = previews.filter((preview) => preview.action !== Action.NoChange);

  for (const preview of previews) log.log(renderPreview(preview));

  if (changed.length === 0) {
    log.log("\nNo changes to apply.");
    return true;
  }

  if (autoApprove) {
    log.log(`\nAuto-approved via DOTAIOS_AUTO_APPROVE (${changed.length} file(s)).`);
    return true;
  }

  if (!input.isTTY) {
    throw new Error("--review requires an interactive terminal. Set DOTAIOS_AUTO_APPROVE=1 for non-interactive runs.");
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question(`\nApply ${changed.length} change(s)? [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
