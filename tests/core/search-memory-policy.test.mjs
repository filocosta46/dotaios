import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveMemoryPolicy } from "../../packages/core/src/memory-policy.mjs";
import { searchAios } from "../../packages/core/src/search.mjs";

async function makeProjectPolicyFixture(t) {
  const aiosPath = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-project-policy-search-"));
  t.after(() => fs.rm(aiosPath, { recursive: true, force: true }));

  const files = new Map([
    ["aios.json", '{"schema_version":"1.2.0"}\n'],
    ["projects/alpha/README.md", "---\nid: project-alpha-001\nproject: alpha\n---\n# Alpha\n\nPOLICY_SEARCH_CANARY selected project corpus\n"],
    ["projects/beta/README.md", "---\nid: project-beta-002\nproject: beta\n---\n# Beta\n\nPOLICY_SEARCH_CANARY OTHER_PROJECT_FILE\n"],
    ["context/identity.md", "# Identity\n\nPOLICY_SEARCH_CANARY PERSONAL_CONTEXT\n"],
    ["decisions/log.md", "# Decisions\n\nPOLICY_SEARCH_CANARY GLOBAL_DECISION\n"],
    ["vault/private.md", "# Private\n\nPOLICY_SEARCH_CANARY PERSONAL_VAULT\n"],
    ["skills/private/SKILL.md", "# Skill\n\nPOLICY_SEARCH_CANARY GLOBAL_SKILL\n"],
    ["references/private.md", "# Reference\n\nPOLICY_SEARCH_CANARY GLOBAL_REFERENCE\n"],
    ["plugins/private/manifest.json", '{"description":"POLICY_SEARCH_CANARY GLOBAL_PLUGIN"}\n'],
    ["memory/daily/2026-08-14.md", "# Daily\n\nPOLICY_SEARCH_CANARY PERSONAL_DAILY\n"],
    ["memory/inbox/note.md", "# Inbox\n\nPOLICY_SEARCH_CANARY PERSONAL_INBOX\n"]
  ]);
  for (const [relative, content] of files) {
    const filePath = path.join(aiosPath, relative);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }

  const eventRecords = [
    { ts: "2026-08-14T09:00:00.000Z", record_id: "event-slug", project: "alpha", summary: "POLICY_SEARCH_CANARY selected slug event" },
    { ts: "2026-08-14T08:00:00.000Z", record_id: "event-id", project_id: "project-alpha-001", summary: "POLICY_SEARCH_CANARY selected id event" },
    { ts: "2026-08-14T07:45:00.000Z", record_id: "event-id-alias", project: "project-alpha-001", summary: "POLICY_SEARCH_CANARY selected id-alias event" },
    { ts: "2026-08-14T07:30:00.000Z", record_id: "event-conflict", project: "alpha", project_id: "project-beta-002", summary: "POLICY_SEARCH_CANARY CONFLICTING_EVENT" },
    { ts: "2026-08-14T07:00:00.000Z", record_id: "event-beta", project: "beta", summary: "POLICY_SEARCH_CANARY OTHER_PROJECT_EVENT" },
    { ts: "2026-08-14T06:00:00.000Z", record_id: "event-global", summary: "POLICY_SEARCH_CANARY UNSCOPED_EVENT" }
  ];
  await fs.writeFile(
    path.join(aiosPath, "memory", "events.jsonl"),
    `${eventRecords.map((record) => JSON.stringify(record)).join("\n")}\n`
  );
  await fs.mkdir(path.join(aiosPath, "memory", "signals"), { recursive: true });
  await fs.writeFile(
    path.join(aiosPath, "memory", "signals", "laptop-2026-08-14.jsonl"),
    `${[
      { ts: "2026-08-14T09:30:00.000Z", record_id: "signal-alpha", project: "alpha", summary: "POLICY_SEARCH_CANARY selected signal" },
      { ts: "2026-08-14T07:30:00.000Z", record_id: "signal-beta", project_id: "project-beta-002", summary: "POLICY_SEARCH_CANARY OTHER_PROJECT_SIGNAL" },
      { ts: "2026-08-14T06:30:00.000Z", record_id: "signal-global", summary: "POLICY_SEARCH_CANARY UNSCOPED_SIGNAL" }
    ].map((record) => JSON.stringify(record)).join("\n")}\n`
  );

  const sessions = [
    { session_id: "session-slug", project: "alpha", title: "POLICY_SEARCH_CANARY selected slug session" },
    { session_id: "session-id", project_id: "project-alpha-001", title: "POLICY_SEARCH_CANARY selected id session" },
    { session_id: "session-id-alias", project: "project-alpha-001", title: "POLICY_SEARCH_CANARY selected id-alias session" },
    { session_id: "session-conflict", project: "alpha", project_id: "project-beta-002", title: "POLICY_SEARCH_CANARY CONFLICTING_SESSION" },
    { session_id: "session-beta", project: "beta", title: "POLICY_SEARCH_CANARY OTHER_PROJECT_SESSION" },
    { session_id: "session-global", title: "POLICY_SEARCH_CANARY UNSCOPED_SESSION" }
  ].map((entry, index) => ({
    ...entry,
    agent: "codex",
    captured_at: `2026-08-14T1${index}:00:00.000Z`,
    path: `memory/sessions/session-${index}.md`
  }));
  await fs.mkdir(path.join(aiosPath, "memory", "sessions"), { recursive: true });
  await fs.writeFile(
    path.join(aiosPath, "memory", "sessions", "index.jsonl"),
    `${sessions.map((entry) => JSON.stringify(entry)).join("\n")}\n`
  );

  return aiosPath;
}

test("project memory searches only selected project files and explicitly attributed evidence", async (t) => {
  const aiosPath = await makeProjectPolicyFixture(t);
  const groups = await searchAios({
    aiosPath,
    query: "POLICY_SEARCH_CANARY",
    projectSelector: "alpha"
  });

  assert.deepEqual(groups.map(({ scope }) => scope), ["sessions", "memory", "projects"]);
  assert.equal(groups.memory, "project");
  assert.equal(groups.receipt, "Memory: This project");
  assert.equal(groups.complete, true);
  assert.equal(groups.scope.project, "alpha");
  assert.equal(groups.scope.project_id, "project-alpha-001");

  const rendered = JSON.stringify(groups);
  for (const included of [
    "selected project corpus",
    "selected slug event",
    "selected id event",
    "selected id-alias event",
    "selected signal",
    "selected slug session",
    "selected id session",
    "selected id-alias session"
  ]) {
    assert.match(rendered, new RegExp(included));
  }
  assert.doesNotMatch(
    rendered,
    /OTHER_PROJECT|UNSCOPED|CONFLICTING_|PERSONAL_|GLOBAL_/,
    "excluded evidence must never enter matching or ranking"
  );
});

test("project memory returns a complete empty result for a forbidden global scope", async (t) => {
  const aiosPath = await makeProjectPolicyFixture(t);
  const groups = await searchAios({
    aiosPath,
    query: "POLICY_SEARCH_CANARY",
    scope: "vault",
    memoryMode: "project",
    projectSelector: "project-alpha-001"
  });

  assert.deepEqual(groups, []);
  assert.equal(groups.complete, true);
  assert.equal(groups.memory, "project");
  assert.equal(groups.receipt, "Memory: This project");
});

test("off memory returns its fixed complete result without touching DotAIOS", async () => {
  const policy = resolveMemoryPolicy({ mode: "off", project: "not-a-real-project" });
  const evidenceReader = new Proxy({}, {
    get() {
      assert.fail("Off must not call the evidence reader");
    }
  });

  const groups = await searchAios({
    aiosPath: "/path/that/must/not/be-resolved",
    query: "anything",
    projectSelector: "not-a-real-project",
    memoryPolicy: policy,
    evidenceReader
  });

  assert.deepEqual(groups, []);
  assert.equal(groups.complete, true);
  assert.equal(groups.memory, "off");
  assert.equal(groups.receipt, "Memory: Off");
  assert.match(groups.notice, /AI app may still keep its own conversation history/i);
  assert.deepEqual(Object.keys(groups), [], "policy metadata preserves array compatibility");
});
