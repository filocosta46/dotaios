import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

// CLAUDE.md hard rule 6: "Local-first. Core logic makes no external network
// calls. Network belongs in ingest/adapters/plugins, never in packages/core."
//
// A past adapter regression let the free, local-first core reach an external
// service on its own. This guard makes that class of regression a failing test
// rather than a code review someone has to remember to do.

const coreSrc = fileURLToPath(new URL("../../packages/core/src", import.meta.url));

// ingest is the documented exception: it is the network adapter that lives in
// core because it is the ingest pipeline itself.
const NETWORK_ADAPTERS = new Set(["ingest.mjs", "lightpanda.mjs"]);

const NETWORK_PATTERNS = [
  { name: "an http(s) endpoint literal", re: /["'`]https?:\/\/[^"'`\s]+["'`]/ },
  { name: "a fetch call", re: /\bfetch\s*\(/ },
  { name: "node:http or node:https", re: /from\s+["']node:https?["']/ }
];

test("packages/core makes no external network calls", async () => {
  const entries = await fs.readdir(coreSrc, { withFileTypes: true });
  const offenders = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
    if (NETWORK_ADAPTERS.has(entry.name)) continue;

    const content = await fs.readFile(path.join(coreSrc, entry.name), "utf8");
    const lines = content.split(/\r?\n/);

    lines.forEach((line, index) => {
      // Comments and doc URLs are not calls.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      for (const pattern of NETWORK_PATTERNS) {
        if (pattern.re.test(line)) {
          offenders.push(`${entry.name}:${index + 1} — ${pattern.name}: ${line.trim().slice(0, 90)}`);
        }
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `packages/core must stay offline. Move these into an adapter under packages/cli/src/adapters/:\n${offenders.join("\n")}`
  );
});
