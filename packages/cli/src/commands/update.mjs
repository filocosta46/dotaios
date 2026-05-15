import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { hasHelpFlag } from "../lib/args.mjs";
import { defaultAiosPath, ensureAiosFolder, expandHome } from "../../../core/src/paths.mjs";
import { appendEvent, appendSignal } from "../../../core/src/memory.mjs";

const HELP_TEXT = `Usage:
  dotaios update [text]

Log a quick update — a decision, meeting, note, or anything that happened.
Saved as a signal in memory/signals/ and as an event in memory/events.jsonl.

With no arguments, prompts interactively.

Examples:
  dotaios update "met Sarah, discussed launch timing"
  dotaios update "decided to drop the analytics dashboard from v1"
  dotaios update

Options:
  --path <dir>  Use a non-default AIOS folder
`;

export async function updateCommand(args) {
  if (hasHelpFlag(args)) {
    console.log(HELP_TEXT);
    return;
  }

  const aiosPath = path.resolve(expandHome(extractPath(args) || defaultAiosPath()));
  await ensureAiosFolder(aiosPath);

  const text = extractText(args);
  const note = text || await promptText();

  if (!note.trim()) {
    console.log("Nothing to save.");
    return;
  }

  const signalsDir = path.join(aiosPath, "memory", "signals");
  const eventsPath = path.join(aiosPath, "memory", "events.jsonl");

  await appendSignal(signalsDir, { type: "update", summary: note.trim(), source: "dotaios update" });
  await appendEvent(eventsPath, { type: "update", summary: note.trim(), source: "dotaios update" });

  console.log("Saved.");
}

async function promptText() {
  if (!process.stdin.isTTY) {
    throw new Error('No text provided and no interactive terminal. Pass text directly: dotaios update "your note"');
  }
  const rl = readline.createInterface({ input, output });
  try {
    return await rl.question("What happened? ");
  } finally {
    rl.close();
  }
}

function extractText(args) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--path") {
      i++;
    } else if (!args[i].startsWith("--")) {
      result.push(args[i]);
    }
  }
  return result.join(" ").trim();
}

function extractPath(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--path" && i + 1 < args.length) return args[i + 1];
  }
  return null;
}
