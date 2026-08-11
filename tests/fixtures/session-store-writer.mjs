import fs from "node:fs/promises";

import { createSessionStore } from "../../packages/core/src/session-store.mjs";

const [mode, aiosPath, value, markerPath] = process.argv.slice(2);
const sourcePath = `${aiosPath}/shared-transcript.jsonl`;
const count = mode === "write" ? Number(value) : 4;

const capture = (store) => store.capture({
  source: {
    path: sourcePath,
    policy: "manual-exact",
    parser: (text) => {
      const parsed = JSON.parse(text);
      return {
        ...parsed,
        session_id: `${String(count).padStart(8, "0")}`,
        turns: parsed.turns.slice(0, count),
      };
    },
  },
});

if (mode === "write") {
  const store = createSessionStore({
    aiosPath,
    lockTimeoutMs: 30_000,
  });
  const result = await capture(store);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (mode === "crash" || mode === "crash-conflict") {
  const phase = value;
  const store = createSessionStore({
    aiosPath,
    lockTimeoutMs: 30_000,
    faultInjector: async (observedPhase) => {
      if (observedPhase !== phase) return;
      await fs.writeFile(markerPath, `${phase}\n`, { mode: 0o600 });
      await new Promise(() => {});
    },
  });
  await capture(store);
} else {
  throw new Error(`Unknown worker mode: ${mode}`);
}
