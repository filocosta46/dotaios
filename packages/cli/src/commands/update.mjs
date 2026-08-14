import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import crypto from "node:crypto";
import path from "node:path";
import { hasHelpFlag } from "../lib/args.mjs";
import { defaultAiosPath, ensureAiosFolder, expandHome } from "../../../core/src/paths.mjs";
import { appendEvent, appendSignal } from "../../../core/src/memory.mjs";
import { resolveProjectContext } from "../../../core/src/projects.mjs";
import { readOptionValue } from "../lib/args.mjs";

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
  --project <slug-or-id>  Attribute the update to a registered project
`;

export async function updateCommand(args) {
  if (hasHelpFlag(args)) {
    console.log(HELP_TEXT);
    return;
  }

  const options = parseOptions(args);
  const aiosPath = path.resolve(expandHome(options.path || defaultAiosPath()));
  await ensureAiosFolder(aiosPath);

  const project = await resolveProjectContext({
    aiosPath,
    project: options.project,
    cwd: process.cwd()
  });
  const text = options.text;
  const note = text || await promptText();

  if (!note.trim()) {
    console.log("Nothing to save.");
    return;
  }

  const signalsDir = path.join(aiosPath, "memory", "signals");
  const eventsPath = path.join(aiosPath, "memory", "events.jsonl");

  const attribution = project
    ? { project: project.slug, ...(project.id ? { project_id: project.id } : {}) }
    : {};
  const recordId = crypto.randomUUID();
  const record = {
    type: "update",
    summary: note.trim(),
    source: "dotaios update",
    record_id: recordId,
    ...attribution
  };
  await appendSignal(signalsDir, record);
  await appendEvent(eventsPath, record);

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

function parseOptions(args) {
  const options = { path: null, project: null, text: [] };
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--path") {
      options.path = readOptionValue(args, i, "--path");
      i++;
    } else if (args[i] === "--project") {
      options.project = readOptionValue(args, i, "--project");
      i++;
    } else if (args[i].startsWith("--")) {
      throw new Error(`Unknown option: ${args[i]}`);
    } else if (!args[i].startsWith("--")) {
      result.push(args[i]);
    }
  }
  options.text = result.join(" ").trim();
  return options;
}
