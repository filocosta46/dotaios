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
  bridgePointer,
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

// The bridge file is loaded by the host on every launch, in every directory.
// Naming the folder is the job; importing it is the bug, because an @-reference
// is expanded by the host at launch and drags the whole router into a session
// that never asked for the person.
test("the global bridge names the AIOS folder instead of importing it", async () => {
  const aiosPath = "/tmp/example-aios";
  // The shipped registry, not hand-made agents: the @-import only ever reached
  // users through the agents that actually get a bridge file written for them.
  const bridged = (await loadAgentRegistry()).filter((agent) => agent.bridge);
  assert.ok(bridged.length >= 3, "the registry must still ship bridge-writing agents");

  for (const agent of bridged) {
    const block = findManagedBlock(await bridgeContent(agent, aiosPath));
    assert.ok(block, `${agent.name}: one managed block`);
    const managed = block.text;

    assert.ok(
      managed.includes(path.join(aiosPath, "AGENTS.md")),
      `${agent.name}: the entrypoint must be findable on request`
    );
    assert.equal(
      managed.includes(`@${aiosPath}`),
      false,
      `${agent.name}: an @-reference is an import, not a pointer`
    );
    assert.match(managed, /working directory/i, `${agent.name}: the unless-rule names the cwd case`);
    assert.match(managed, /user asks/i, `${agent.name}: the unless-rule names the on-request case`);
    assert.equal(
      /before recommendations that depend on identity/.test(managed),
      false,
      `${agent.name}: no always-on identity read`
    );
    assert.equal(
      /at session start/.test(managed),
      false,
      `${agent.name}: no always-on boot order`
    );
    assert.ok(
      managed.length < 1500,
      `${agent.name}: an always-loaded block stays small (${managed.length} characters)`
    );
  }
});

// doctor decides "this bridge points here" by matching whole managed lines
// against bridgePointer().accepted. Changing what activate writes without
// teaching doctor both spellings would warn on every install: the fresh ones
// because the new line is unknown, the old ones because they were never rewritten.
test("every bridge this release writes carries a pointer line doctor accepts", async () => {
  const aiosPath = "/tmp/example-aios";
  const entrypoint = path.join(aiosPath, "AGENTS.md");
  const { current, accepted } = bridgePointer(aiosPath);

  for (const agent of (await loadAgentRegistry()).filter((agent) => agent.bridge)) {
    const block = findManagedBlock(await bridgeContent(agent, aiosPath));
    assert.ok(
      block.text.split(/\r?\n/).includes(current),
      `${agent.name}: managed block must contain the pointer line verbatim`
    );
  }

  for (const legacy of [
    `@${entrypoint}`,
    `DotAIOS entrypoint (read this file first): ${entrypoint}`,
    `Read ${entrypoint} first.`
  ]) {
    assert.ok(accepted.includes(legacy), `bridges written before this release stay valid: ${legacy}`);
  }
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

test("registry normalization rejects malformed external-dir keys and control-character paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-invalid-registry-"));
  try {
    await fs.writeFile(
      path.join(root, "agents.json"),
      JSON.stringify({
        agents: [
          {
            name: "Bad Key Runtime",
            detect: ".bad-key",
            bridge: null,
            skills: {
              mode: "config-external-dir",
              configFile: ".bad-key/config.yaml",
              key: "runner..skill_paths"
            }
          },
          {
            name: "Bad Path Runtime",
            detect: ".bad-path",
            bridge: null,
            skills: {
              mode: "config-external-dir",
              configFile: ".bad-path\0/config.yaml",
              key: "runner.skill_paths"
            }
          },
          {
            name: "Absolute Skill Runtime",
            detect: ".absolute-skill",
            bridge: null,
            skills: { mode: "symlink", dir: "/" }
          }
        ]
      })
    );

    const registry = await loadAgentRegistry(root);
    assert.equal(registry.find((agent) => agent.name === "Bad Key Runtime").skills, undefined);
    assert.equal(registry.find((agent) => agent.name === "Bad Path Runtime").skills, undefined);
    assert.equal(registry.find((agent) => agent.name === "Absolute Skill Runtime").skills, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("agent registry loading refuses linked, oversized, and invalid UTF-8 configuration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-strict-registry-"));
  const outside = path.join(root, "outside.json");
  const registryPath = path.join(root, "agents.json");
  try {
    await fs.writeFile(outside, JSON.stringify({ agents: [] }));
    await fs.symlink(outside, registryPath);
    await assert.rejects(() => loadAgentRegistry(root), /single-link regular file/i);

    await fs.unlink(registryPath);
    await fs.writeFile(registryPath, Buffer.alloc(1024 * 1024 + 1, 0x20));
    await assert.rejects(() => loadAgentRegistry(root), /byte bound/i);

    await fs.writeFile(registryPath, Buffer.from([0x7b, 0xff, 0x7d]));
    await assert.rejects(() => loadAgentRegistry(root), /UTF-8/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
