import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MANAGED_END,
  MANAGED_START,
  bridgeContent,
  bridgePath,
  findManagedBlock,
  isAgentInstalled,
  loadAgentRegistry
} from "../../packages/core/src/bridges.mjs";

test("managed bridge detection requires ordered markers", () => {
  const block = `${MANAGED_START}\nmanaged\n${MANAGED_END}`;
  assert.deepEqual(findManagedBlock(`before\n${block}\nafter`), {
    start: 7,
    end: 7 + block.length,
    text: block
  });
  assert.equal(findManagedBlock(`${MANAGED_END}\n${MANAGED_START}`), null);
  assert.equal(findManagedBlock(MANAGED_START), null);

  const malformed = [
    `${MANAGED_END}\n${block}`,
    `${block}\n${MANAGED_END}`,
    `${MANAGED_START}\n${block}`,
    `${block}\n${MANAGED_START}`,
    `${block}\n${block}`
  ];
  for (const content of malformed) {
    assert.equal(findManagedBlock(content), null, "extra managed markers must fail closed");
  }
});

test("registry preserves non-bridge runtimes such as Hermes", async () => {
  const registry = await loadAgentRegistry();
  const hermes = registry.find((agent) => agent.name === "Hermes");

  assert.ok(hermes);
  assert.equal(hermes.bridge, null);
  assert.equal(hermes.detect, ".hermes");
  assert.equal(bridgePath("/tmp/home", hermes), null);
});

test("Antigravity detection follows its documented Gemini-owned directory", async () => {
  const registry = await loadAgentRegistry();
  const antigravity = registry.find((agent) => agent.name === "Antigravity");

  assert.ok(antigravity);
  assert.equal(antigravity.detect, ".gemini/antigravity");
  assert.equal(antigravity.skills.dir, ".gemini/antigravity/skills");
});

test("agent detection recognizes a declared command on PATH without a config folder", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-agent-command-"));
  try {
    const command = process.platform === "win32" ? "example-agent.CMD" : "example-agent";
    await fs.writeFile(path.join(root, command), "", { mode: 0o755 });
    const installed = await isAgentInstalled(
      path.join(root, "empty-home"),
      { command: "example-agent", detect: ".example-agent" },
      {
        env: {
          PATH: root,
          ...(process.platform === "win32" ? { PATHEXT: ".CMD;.EXE" } : {})
        },
        platform: process.platform
      }
    );

    assert.equal(installed, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("managed bridges route working memory through the canonical projection", async () => {
  const content = await bridgeContent(
    { name: "Test Agent", include: "" },
    "/tmp/example-aios"
  );

  assert.match(content, /events, signals, and saved sessions only through the canonical bounded projection/);
  assert.match(content, /dotaios brief --compact/);
  assert.match(content, /`read_working_context`, `search_aios`, and `resolve_skill`/);
  const retiredToolNames = [
    ["read", "session", "digest"], ["read", "context"], ["list", "skills"],
    ["search", "memory"], ["search", "vault"], ["list", "projects"],
    ["log", "event"], ["google", "status"], ["google", "gmail", "search"],
    ["google", "calendar", "agenda"], ["google", "drive", "search"]
  ].map((parts) => parts.join("_"));
  assert.equal(retiredToolNames.some((name) => content.includes(name)), false);
});

test("user Antigravity overrides replace the bundled adapter by stable name", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-registry-"));
  try {
    await fs.writeFile(
      path.join(root, "agents.json"),
      JSON.stringify({
        agents: [{
          name: "Antigravity",
          detect: ".custom-antigravity",
          bridge: null,
          skills: { mode: "symlink", dir: ".custom-antigravity/skills" }
        }]
      })
    );

    const registry = await loadAgentRegistry(root);
    const matches = registry.filter((agent) => agent.name.toLowerCase().startsWith("antigravity"));
    assert.equal(matches.length, 1);
    assert.equal(matches[0].detect, ".custom-antigravity");
    assert.equal(matches[0].skills.dir, ".custom-antigravity/skills");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
