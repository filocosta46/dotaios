import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  deriveProjectionRow,
  renderSessionMarkdown,
  sessionFilename,
} from "../../packages/core/src/session-codec.mjs";
import { createSessionStore } from "../../packages/core/src/session-store.mjs";

function tmpAios() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-session-store-"));
  fs.writeFileSync(path.join(root, "aios.json"), '{"version":"1"}\n');
  return root;
}

function turns(count) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `turn-${index + 1}`,
  }));
}

function session(overrides = {}) {
  return {
    agent: "claude-code",
    session_id: "11111111",
    captured_at: "2026-08-11T10:00:00.000Z",
    source_type: "claude-code",
    title: "turn-1",
    turns: turns(2),
    ...overrides,
  };
}

async function captureSource(store, sourcePath, value, policy = "manual-exact") {
  await fsp.writeFile(sourcePath, JSON.stringify(value), { mode: 0o600 });
  return store.capture({
    source: {
      path: sourcePath,
      policy,
      parser: (text) => JSON.parse(text),
    },
  });
}

test("capture serializes continuation semantics and derives the projection", async () => {
  const aiosPath = tmpAios();
  const sourcePath = path.join(aiosPath, "transcript.json");
  const store = createSessionStore({ aiosPath, lockTimeoutMs: 5_000 });

  const created = await captureSource(store, sourcePath, session());
  assert.equal(created.outcome, "created");

  const older = await captureSource(store, sourcePath, session({ turns: turns(1) }));
  assert.equal(older.outcome, "idempotent");

  const grown = await captureSource(store, sourcePath, session({
    session_id: "22222222",
    captured_at: "2026-08-11T11:00:00.000Z",
    turns: turns(4),
  }));
  assert.equal(grown.outcome, "grown");
  assert.equal(grown.session.session_id, created.session.session_id);
  assert.equal(grown.session.captured_at, created.session.captured_at);

  const catalog = await store.search({ purpose: "catalog", query: "" });
  assert.equal(catalog.rows.length, 1);
  assert.equal(catalog.rows[0].turns, 4);
  assert.equal(catalog.rows[0].session_id, created.session.session_id);
  assert.equal(catalog.warnings.malformed_rows, 0);
});

for (const writers of [2, 16, 32]) {
  const timeout = writers === 32 ? 300_000 : 120_000;
  test(`${writers} in-process same-source continuations converge to one complete session`, { timeout }, async () => {
    const aiosPath = tmpAios();
    const sourcePath = path.join(aiosPath, "shared-source.json");
    await fsp.writeFile(sourcePath, "{}\n", { mode: 0o600 });
    const store = createSessionStore({ aiosPath, lockTimeoutMs: timeout - 30_000 });
    const outcomes = await Promise.all(Array.from({ length: writers }, (_, index) => (
      store.capture({
        source: {
          path: sourcePath,
          policy: "manual-exact",
          parser: () => session({ turns: turns(writers - index) }),
        },
      })
    )));

    assert.ok(outcomes.every((outcome) => ["created", "grown", "idempotent"].includes(outcome.outcome)));
    assert.equal(outcomes.filter((outcome) => outcome.outcome === "created").length, 1);
    const grownTurnCounts = outcomes
      .filter((outcome) => outcome.outcome === "grown")
      .map((outcome) => outcome.session.turns.length);
    assert.equal(
      new Set(grownTurnCounts).size,
      grownTurnCounts.length,
      "only one writer may report each committed growth",
    );
    const result = await store.search({ purpose: "body" });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].turns, writers);
    for (let index = 1; index <= writers; index += 1) {
      assert.equal(
        result.rows[0].body.split("\n").filter((line) => line === `turn-${index}`).length,
        1,
      );
    }
  });
}

test("capture assigns source authority instead of trusting parser or prepared metadata", async () => {
  const aiosPath = tmpAios();
  const sourcePath = path.join(aiosPath, "transcript.json");
  const store = createSessionStore({ aiosPath });

  const sourced = await captureSource(store, sourcePath, session({
    agent: "forged-agent",
    source_type: "claude-code",
  }));
  assert.equal(sourced.session.agent, "manual");
  assert.equal(sourced.session.source_type, "import");
  assert.match(sourced.session.session_id, /^[0-9a-f]{8}$/);
  assert.notEqual(sourced.session.session_id, "11111111");

  const prepared = await store.capture({
    preparedMarkdown: renderSessionMarkdown(session({
      session_id: "22222222",
      agent: "claude-code",
      source_type: "claude-code",
    })),
  });
  assert.equal(prepared.session.agent, "prepared");
  assert.equal(prepared.session.source_type, "prepared");
  assert.match(prepared.session.session_id, /^[0-9a-f]{8}$/);
  assert.notEqual(prepared.session.session_id, "22222222");

  const pasted = await store.capture({
    session: session({
      session_id: "33333333",
      agent: "claude-code",
      source_type: "claude-code",
    }),
  });
  assert.equal(pasted.session.agent, "paste");
  assert.equal(pasted.session.source_type, "paste");
  assert.match(pasted.session.session_id, /^[0-9a-f]{8}$/);
  assert.notEqual(pasted.session.session_id, "33333333");
});

test("capture candidates do not need to mint the store-owned session ID", async () => {
  const aiosPath = tmpAios();
  const store = createSessionStore({ aiosPath });
  const candidate = session();
  delete candidate.session_id;

  const created = await store.capture({ session: candidate });

  assert.equal(created.outcome, "created");
  assert.match(created.session.session_id, /^[0-9a-f]{8}$/);
});

test("SessionStore retries six-character ID-prefix collisions and refuses bounded exhaustion", async () => {
  const aiosPath = tmpAios();
  const generatedIds = [
    "abcdef01",
    "abcdef02",
    "12345678",
    ...Array.from({ length: 16 }, (_, index) => `abcdef${index.toString(16).padStart(2, "0")}`),
  ];
  const store = createSessionStore({
    aiosPath,
    sessionIdGenerator: () => generatedIds.shift(),
  });

  const first = await store.capture({ session: session() });
  assert.equal(first.session.session_id, "abcdef01");

  const second = await store.capture({ session: session({
    captured_at: "2026-08-12T10:00:00.000Z",
    title: "second collision candidate",
  }) });
  assert.equal(second.session.session_id, "12345678");
  assert.equal(generatedIds.length, 16, "one equal-prefix candidate must have been rejected");

  const beforeExhaustion = await treeBytes(aiosPath);
  await assert.rejects(
    () => store.capture({ session: session({
      captured_at: "2026-08-13T10:00:00.000Z",
      title: "exhausted collision candidate",
    }) }),
    { code: "DOTAIOS_SESSION_ID_COLLISION" },
  );
  assert.equal(generatedIds.length, 0, "collision retry remains bounded at sixteen attempts");
  assert.deepEqual(await treeBytes(aiosPath), beforeExhaustion);
});

test("divergent versions are preserved and later capture requires reconciliation", async () => {
  const aiosPath = tmpAios();
  const sourcePath = path.join(aiosPath, "transcript.json");
  const store = createSessionStore({ aiosPath });

  await captureSource(store, sourcePath, session());
  const conflict = await captureSource(store, sourcePath, session({
    session_id: "33333333",
    turns: [{ role: "user", content: "different" }],
  }));
  assert.equal(conflict.outcome, "conflict_preserved");

  const catalog = await store.search({ purpose: "catalog", query: "" });
  assert.equal(catalog.rows.length, 2);
  assert.ok(catalog.rows.every((row) => row.conflict_group));

  await fsp.writeFile(sourcePath, JSON.stringify(session({ turns: turns(6) })), { mode: 0o600 });
  const before = await treeBytes(aiosPath);
  const blocked = await store.capture({
    source: { path: sourcePath, policy: "manual-exact", parser: (text) => JSON.parse(text) },
  });
  assert.equal(blocked.outcome, "reconciliation_required");
  assert.deepEqual(await treeBytes(aiosPath), before);
});

test("report-only reconcile finds drift without creating operational state", async () => {
  const aiosPath = tmpAios();
  const sourcePath = path.join(aiosPath, "transcript.json");
  const store = createSessionStore({ aiosPath });
  const created = await captureSource(store, sourcePath, session());
  const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
  await fsp.writeFile(indexPath, "{not-json}\n", { mode: 0o600 });
  const before = await treeBytes(aiosPath);

  const report = await store.reconcile({ apply: false });
  assert.equal(report.malformed_rows, 1);
  assert.equal(report.orphan_markdown.length, 1);
  assert.deepEqual(await treeBytes(aiosPath), before);
  const applied = await store.reconcile({ apply: true });
  assert.equal(applied.outcome, "rebuilt");
  assert.equal(applied.rows, 1);
  assert.equal((await store.search({ purpose: "exact", sessionId: created.session.session_id })).rows.length, 1);
});

test("delete requires exact proved ownership and is durable", async () => {
  const aiosPath = tmpAios();
  const sourcePath = path.join(aiosPath, "transcript.json");
  const store = createSessionStore({ aiosPath });
  const created = await captureSource(store, sourcePath, session());

  await assert.rejects(() => store.delete({ sessionId: "missing00" }), { code: "DOTAIOS_SESSION_NOT_FOUND" });
  const removed = await store.delete({ sessionId: created.session.session_id });
  assert.equal(removed.outcome, "deleted");
  assert.equal((await store.search({ purpose: "catalog", query: "" })).rows.length, 0);
});

test("exact delete remains available when canonical inventory exceeds the normal read bound", async () => {
  const aiosPath = tmpAios();
  const roomy = createSessionStore({ aiosPath, limits: { maxCanonicalFiles: 2 } });
  const first = await roomy.capture({ session: session({ session_id: "11111111" }) });
  await roomy.capture({ session: session({
    session_id: "22222222",
    captured_at: "2026-08-11T11:00:00.000Z",
  }) });

  const bounded = createSessionStore({ aiosPath, limits: { maxCanonicalFiles: 1 } });
  await assert.rejects(
    () => bounded.search({ purpose: "catalog" }),
    { code: "DOTAIOS_PROJECTION_READ_BUDGET_EXCEEDED" },
  );
  const removed = await bounded.delete({ sessionId: first.session.session_id });
  assert.equal(removed.outcome, "deleted");
  assert.equal((await bounded.search({ purpose: "catalog" })).rows.length, 1);
});

test("exact delete remains available with a literal 513th canonical artifact", { timeout: 30_000 }, async () => {
  const aiosPath = tmpAios();
  const dateRoot = path.join(aiosPath, "memory", "sessions", "2026-08-11");
  await fsp.mkdir(dateRoot, { recursive: true });
  const rows = [];
  let targetId;
  for (let index = 0; index < 513; index += 1) {
    const value = session({ session_id: `${index.toString(16).padStart(6, "0")}aa` });
    const filename = sessionFilename(value);
    const relativePath = `memory/sessions/2026-08-11/${filename}`;
    await fsp.writeFile(path.join(dateRoot, filename), renderSessionMarkdown(value), { mode: 0o600 });
    rows.push(deriveProjectionRow(value, relativePath));
    if (index === 512) targetId = value.session_id;
  }
  await fsp.writeFile(
    path.join(aiosPath, "memory", "sessions", "index.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    { mode: 0o600 },
  );

  await assert.rejects(
    () => createSessionStore({ aiosPath, limits: { maxEntries: 512 } }).delete({ sessionId: targetId }),
    { code: "DOTAIOS_PROJECTION_READ_BUDGET_EXCEEDED" },
  );
  const store = createSessionStore({ aiosPath });
  await assert.rejects(
    () => store.search({ purpose: "catalog" }),
    { code: "DOTAIOS_PROJECTION_READ_BUDGET_EXCEEDED" },
  );
  const removed = await store.delete({ sessionId: targetId });
  assert.equal(removed.outcome, "deleted");
  assert.equal((await store.search({ purpose: "catalog" })).rows.length, 512);
});

test("read paths reject hostile projection targets and create no repair artifacts", async () => {
  const aiosPath = tmpAios();
  const sessionsRoot = path.join(aiosPath, "memory", "sessions");
  await fsp.mkdir(sessionsRoot, { recursive: true });
  const canary = path.join(aiosPath, "outside-canary");
  await fsp.writeFile(canary, "outside\n");
  await fsp.symlink(canary, path.join(sessionsRoot, "index.jsonl"));
  const before = await treeBytes(aiosPath);

  const store = createSessionStore({ aiosPath });
  await assert.rejects(() => store.search({ purpose: "catalog", query: "" }));
  assert.deepEqual(await treeBytes(aiosPath), before);
  assert.equal(await fsp.readFile(canary, "utf8"), "outside\n");
  assert.equal(fs.existsSync(path.join(aiosPath, ".dotaios", "session-store")), false);
});

test("projection row count is bounded independently of byte size", async () => {
  const aiosPath = tmpAios();
  const created = await createSessionStore({ aiosPath }).capture({ session: session() });
  const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
  const row = JSON.parse((await fsp.readFile(indexPath, "utf8")).trim());
  await fsp.writeFile(indexPath, Array.from({ length: 4 }, () => JSON.stringify(row)).join("\n") + "\n");

  await assert.rejects(
    () => createSessionStore({ aiosPath, limits: { maxEntries: 3 } }).search({ purpose: "catalog" }),
    { code: "DOTAIOS_SESSION_INVENTORY_TOO_LARGE" },
  );
  assert.equal(created.committed, true);
});

test("source replacement during parsing is refused before publication", async () => {
  const aiosPath = tmpAios();
  const sourcePath = path.join(aiosPath, "transcript.json");
  const parkedPath = path.join(aiosPath, "transcript-original.json");
  await fsp.writeFile(sourcePath, JSON.stringify(session()), { mode: 0o600 });
  const store = createSessionStore({ aiosPath });

  await assert.rejects(
    () => store.capture({
      source: {
        path: sourcePath,
        policy: "manual-exact",
        parser: async (text) => {
          await fsp.rename(sourcePath, parkedPath);
          await fsp.writeFile(sourcePath, text, { mode: 0o600 });
          return JSON.parse(text);
        },
      },
    }),
    { code: "DOTAIOS_SESSION_SOURCE_CHANGED" },
  );
  assert.equal(fs.existsSync(path.join(aiosPath, "memory")), false);
  assert.deepEqual(await fsp.readFile(sourcePath), await fsp.readFile(parkedPath));
});

test("unexpected filesystem diagnostics are path-free", async () => {
  const aiosPath = tmpAios();
  const sourcePath = path.join(aiosPath, "sensitive-transcript.json");
  await fsp.writeFile(sourcePath, JSON.stringify(session()), { mode: 0o600 });
  const filesystem = Object.create(fsp);
  filesystem.realpath = async (candidate) => {
    if (path.resolve(String(candidate)) === sourcePath) {
      const error = new Error(`sensitive failure at ${sourcePath}`);
      error.code = "EIO";
      throw error;
    }
    return fsp.realpath(candidate);
  };

  await assert.rejects(
    () => createSessionStore({ aiosPath, filesystem }).capture({
      source: { path: sourcePath, policy: "manual-exact", parser: JSON.parse },
    }),
    (error) => {
      assert.equal(error.code, "DOTAIOS_SESSION_STORE_IO");
      assert.equal(error.message.includes(sourcePath), false);
      assert.equal(error.message.includes("sensitive-transcript"), false);
      return true;
    },
  );
});

async function treeBytes(root) {
  const result = {};
  async function walk(current, relative = "") {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = path.posix.join(relative, entry.name);
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) result[rel] = `link:${await fsp.readlink(full)}`;
      else if (entry.isDirectory()) await walk(full, rel);
      else result[rel] = (await fsp.readFile(full)).toString("base64");
    }
  }
  await walk(root);
  return result;
}
