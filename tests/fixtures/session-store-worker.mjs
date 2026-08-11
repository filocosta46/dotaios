import fs from "node:fs/promises";

import { createSessionStore } from "../../packages/core/src/session-store.mjs";

const [action, aiosPath, phase, markerPath] = process.argv.slice(2);
const sourcePath = `${aiosPath}/shared-source.json`;

const makeSession = (turnCount) => ({
  agent: "manual",
  session_id: "11111111",
  captured_at: "2026-08-11T10:00:00.000Z",
  source_type: "import",
  source_path: sourcePath,
  title: "turn-1",
  turns: Array.from({ length: turnCount }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `turn-${index + 1}`,
  })),
});

const store = createSessionStore({
  aiosPath,
  lockTimeoutMs: 30_000,
  faultInjector: async (observedPhase, context) => {
    if (observedPhase !== phase || context.kind !== action) return;
    const handle = await fs.open(markerPath, "wx", 0o600);
    try {
      await handle.writeFile(`${action}:${phase}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await new Promise(() => { setInterval(() => {}, 1_000); });
  },
});

let result;
if (["create", "grow", "conflict"].includes(action)) {
  result = await store.capture({
    source: {
      path: sourcePath,
      policy: "manual-exact",
      parser: (text) => JSON.parse(text),
    },
  });
} else if (action === "delete") {
  const catalog = await store.search({ purpose: "metadata", query: "", limit: 1 });
  result = await store.delete({ sessionId: catalog.rows[0].session_id });
} else if (action === "reconcile") {
  result = await store.reconcile({ apply: true });
} else {
  throw new Error(`Unknown SessionStore worker action: ${action}`);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
