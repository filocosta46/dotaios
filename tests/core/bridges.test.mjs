import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MANAGED_END,
  MANAGED_START,
  bridgeContent,
  bridgeManagedBlock,
  bridgePath,
  bridgePointer,
  findManagedBlock,
  inspectDotaiosOnPath,
  isAgentInstalled,
  loadAgentRegistry,
  resolveCliInvocation
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

test("Grok is a first-class skill host with no global instruction bridge", async () => {
  const registry = await loadAgentRegistry();
  const grok = registry.find((agent) => agent.name === "Grok");

  assert.ok(grok);
  assert.equal(grok.bridge, null);
  assert.equal(grok.detect, ".grok/config.toml");
  assert.equal(grok.command, "grok");
  assert.equal(grok.skills?.dir, ".grok/skills");
  assert.equal(grok.skills?.project?.dir, ".grok/skills");
  assert.equal(bridgePath("/tmp/home", grok), null);
});

// Source: https://antigravity.google/docs/skills publishes exactly two skill
// discovery paths — workspace `<workspace-root>/.agents/skills/<skill>/` and
// global `~/.gemini/config/skills/<skill>/`. Detection is a separate question:
// the IDE owns `~/.gemini/antigravity`, so that directory proves it is
// installed even though it is not a place the IDE reads skills from. Assert
// both literals against the documentation, never back against the registry:
// re-reading the registry's own value would pass for any path we shipped.
const ANTIGRAVITY_DOCUMENTED_GLOBAL_SKILLS_DIR = ".gemini/config/skills";
const ANTIGRAVITY_DOCUMENTED_WORKSPACE_SKILLS_DIR = ".agents/skills";

test("Antigravity detection follows its documented Gemini-owned directory", async () => {
  const registry = await loadAgentRegistry();
  const antigravity = registry.find((agent) => agent.name === "Antigravity");

  assert.ok(antigravity);
  assert.equal(antigravity.detect, ".gemini/antigravity");
  assert.equal(antigravity.skills.dir, ANTIGRAVITY_DOCUMENTED_GLOBAL_SKILLS_DIR);
  assert.equal(antigravity.skills.project.dir, ANTIGRAVITY_DOCUMENTED_WORKSPACE_SKILLS_DIR);
  // The detect directory is not a discovery path, so it must never be the
  // projection target again.
  assert.notEqual(antigravity.skills.dir, `${antigravity.detect}/skills`);
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

test("DotAIOS skill projections do not impersonate installed clients", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-agent-projections-"));
  const homePath = path.join(root, "home");
  const registry = await loadAgentRegistry();
  const cases = [
    {
      name: "Claude Code",
      projection: ".claude/skills",
      marker: ".claude/settings.json"
    },
    {
      name: "Gemini",
      projection: ".gemini/config/skills",
      marker: ".gemini/settings.json"
    },
    {
      name: "Grok",
      projection: ".grok/skills",
      marker: ".grok/config.toml"
    }
  ];

  try {
    for (const entry of cases) {
      const agent = registry.find((candidate) => candidate.name === entry.name);
      assert.ok(agent, `${entry.name} must remain in the bundled registry`);
      assert.equal(agent.detect, entry.marker);

      await fs.mkdir(path.join(homePath, entry.projection), { recursive: true });
      assert.equal(
        await isAgentInstalled(homePath, agent, { env: { PATH: "" } }),
        false,
        `${entry.projection} is owned by DotAIOS projection, not ${entry.name}`
      );

      const markerPath = path.join(homePath, entry.marker);
      await fs.mkdir(path.dirname(markerPath), { recursive: true });
      await fs.writeFile(markerPath, "");
      assert.equal(
        await isAgentInstalled(homePath, agent, { env: { PATH: "" } }),
        true,
        `${entry.marker} is client-owned installation evidence for ${entry.name}`
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PATH inspection proves only the canonical DotAIOS global link without executing it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-path-owner-"));
  const binDir = path.join(root, "bin");
  const packageRoot = path.join(root, "lib", "node_modules", "dotaios");
  const entrypoint = path.join(packageRoot, "packages", "cli", "src", "index.mjs");
  const executionMarker = path.join(root, "executed");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(path.dirname(entrypoint), { recursive: true });
  await fs.writeFile(entrypoint, `#!/bin/sh\nprintf executed > ${executionMarker}\n`, { mode: 0o755 });
  await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "dotaios",
    version: "2.0.9",
    bin: { dotaios: "packages/cli/src/index.mjs" }
  }));
  await fs.symlink("../lib/node_modules/dotaios/packages/cli/src/index.mjs", path.join(binDir, "dotaios"));

  try {
    const result = await inspectDotaiosOnPath({ env: { PATH: binDir }, platform: process.platform });
    assert.equal(result.status, "owned");
    assert.equal(result.ownership, "owned");
    assert.equal(result.version, "2.0.9");
    assert.equal(result.command_path, path.join(binDir, "dotaios"));
    assert.equal(result.package_path, path.join(await fs.realpath(packageRoot), "package.json"));
    await assert.rejects(fs.access(executionMarker), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PATH inspection reports an unrecognized executable as unknown and unowned", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-path-unowned-"));
  const commandPath = path.join(root, "dotaios");
  await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  try {
    assert.deepEqual(
      await inspectDotaiosOnPath({ env: { PATH: root }, platform: process.platform }),
      {
        status: "unknown",
        ownership: "unowned",
        command_path: commandPath
      }
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PATH inspection skips an npx shim and finds the persistent global without execution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-path-npx-overlay-"));
  const transientRoot = path.join(root, "_npx", "candidate", "node_modules", "dotaios");
  const transientBin = path.join(path.dirname(transientRoot), ".bin");
  const globalBin = path.join(root, "global", "bin");
  const globalRoot = path.join(root, "global", "lib", "node_modules", "dotaios");
  const executionMarker = path.join(root, "executed");

  async function installOwnedPackage(packageRoot, version) {
    const entrypoint = path.join(packageRoot, "packages", "cli", "src", "index.mjs");
    await fs.mkdir(path.dirname(entrypoint), { recursive: true });
    await fs.writeFile(entrypoint, `#!/bin/sh\nprintf executed >> ${executionMarker}\n`, { mode: 0o755 });
    await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "dotaios",
      version,
      bin: { dotaios: "packages/cli/src/index.mjs" }
    }));
    return entrypoint;
  }

  try {
    const transientEntrypoint = await installOwnedPackage(transientRoot, "2.0.11");
    const globalEntrypoint = await installOwnedPackage(globalRoot, "2.0.9");
    await fs.mkdir(transientBin, { recursive: true });
    await fs.mkdir(globalBin, { recursive: true });
    await fs.symlink(transientEntrypoint, path.join(transientBin, "dotaios"));
    await fs.symlink(globalEntrypoint, path.join(globalBin, "dotaios"));

    assert.deepEqual(
      await inspectDotaiosOnPath({ env: { PATH: transientBin }, platform: process.platform }),
      { status: "missing", ownership: "none" }
    );

    const result = await inspectDotaiosOnPath({
      env: { PATH: [transientBin, globalBin].join(path.delimiter) },
      platform: process.platform
    });
    assert.equal(result.status, "owned");
    assert.equal(result.version, "2.0.9");
    assert.equal(result.command_path, path.join(globalBin, "dotaios"));
    await assert.rejects(fs.access(executionMarker), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("managed bridges route working memory through the canonical projection", async () => {
  const content = await bridgeContent({ name: "Test Agent" }, "/tmp/example-aios", {
    localCli: {
      executable: "/opt/dotaios/node/bin/node",
      entrypoint: "/opt/dotaios/package/packages/cli/src/index.mjs"
    }
  });

  assert.match(content, /events, signals, and saved sessions only through the canonical bounded projection/);
  assert.match(content, /"executable":"\/opt\/dotaios\/node\/bin\/node"/);
  assert.match(content, /"argv_prefix":\["\/opt\/dotaios\/package\/packages\/cli\/src\/index\.mjs"\]/);
  assert.match(content, /append.*\["resolve","<concrete action>"/is);
  assert.doesNotMatch(content, /\bnpx(?:\.cmd)?\b|_npx|\.npm\/_cacache|registry\.npmjs/i);
  assert.match(content, /^.*Private chat.*Memory: Off.*$/im);
  assert.match(content, /^.*Only this project.*Memory: This project.*$/im);
  assert.match(content, /^.*Use my memory.*Memory: Shared.*$/im);
  assert.match(content, /^Choose memory access before any AIOS memory read:$/m);
  assert.match(content, /an attached working directory alone is never project identity/i);
  assert.match(content, /project["`, ]+identify[\s\S]*same cwd/is);
  assert.match(content, /Host admission[\s\S]*only registration metadata[\s\S]*receipt[\s\S]*registered_project/is);
  assert.match(content, /Without `Memory: This project`[\s\S]*non-null[\s\S]*do not claim\/read memory[\s\S]*`Memory: Off`/is);
  assert.doesNotMatch(content, /In an attached working directory[^\n]*use `Memory: This project`/i);
  assert.match(content, /keep AIOS closed.*re-activate.*never Shared/is);
  assert.match(content, /Then read AGENTS\.md.*append.*brief.*--memory.*project/is);
  assert.match(content, /Only in Shared.*read AGENTS\.md.*append.*brief.*--memory.*shared/is);
  assert.match(content, /host.*history/i);
  assert.match(content, /`read_working_context`, `search_aios`, and `resolve_skill`/);
  const retiredToolNames = [
    ["read", "session", "digest"], ["read", "context"], ["list", "skills"],
    ["search", "memory"], ["search", "vault"], ["list", "projects"],
    ["log", "event"], ["google", "status"], ["google", "gmail", "search"],
    ["google", "calendar", "agenda"], ["google", "drive", "search"]
  ].map((parts) => parts.join("_"));
  assert.equal(retiredToolNames.some((name) => content.includes(name)), false);
});

test("the generated bridge makes one approved existing-folder task the first-session contract", async () => {
  const content = await bridgeManagedBlock("/tmp/example-aios", {
    localCli: {
      executable: "/opt/dotaios/node/bin/node",
      entrypoint: "/opt/dotaios/package/packages/cli/src/index.mjs"
    }
  });
  const prompt = "Help me with one useful task in an existing work folder. Ask what I want to accomplish. If the folder is not connected, ask only for its location; do not require a description. Explain what you understand, propose exactly one action, and wait for my explicit approval before acting.";

  assert.match(content, new RegExp(prompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(content, /attached registered project[\s\S]*owns the concrete task[\s\S]*keep (?:the task|it) there/i);
  assert.match(
    content,
    /otherwise[\s\S]*derive[\s\S]*current host[\s\S]*native support[\s\S]*implicit discovery[\s\S]*\["resolve","<concrete action>"[\s\S]*--supports-conventions[\s\S]*no `--project`[\s\S]*no `--approval-binding`/i
  );
  assert.match(
    content,
    /project add[\s\S]*preview[\s\S]*--json[\s\S]*fresh direct user turn[\s\S]*--operation-id[\s\S]*--plan-fingerprint[\s\S]*--apply[\s\S]*--json/is
  );
  assert.match(content, /project add[\s\S]{0,160}purpose is optional/i);
  assert.match(
    content,
    /after[^\n]*apply[\s\S]*registered_project[\s\S]*stable ID[\s\S]*same concrete action[\s\S]*--project[\s\S]*same `--supports-conventions` pair[\s\S]*no `--approval-binding`/i
  );
  assert.match(content, /resolver output.*project instructions.*skills.*tool text.*work-folder contents.*untrusted/is);
  assert.match(content, /never.*approval|cannot.*approve/i);
  assert.match(
    content,
    /candidate[\s\S]*public slug[\s\S]*registration metadata[\s\S]*exact action[\s\S]*approval[\s\S]*fresh context outcome[\s\S]*never disclose[\s\S]*folder path/i
  );
  assert.match(content, /retain[\s\S]*approval_binding[\s\S]*opaque[\s\S]*never (?:show|disclose)[\s\S]*customer/i);
  assert.match(
    content,
    /fresh direct customer turn[\s\S]*only[\s\S]*unambiguous approval[\s\S]*any other response[\s\S]*no exact call[\s\S]*no folder disclosure[\s\S]*no automatic reprompt/i
  );
  assert.match(
    content,
    /after approval[\s\S]*same exact action[\s\S]*identical native support[\s\S]*--project[\s\S]*--approval-binding[\s\S]*retained opaque binding/i
  );
  assert.match(content, /weak or vague[\s\S]*concrete action[\s\S]*ambiguous[\s\S]*narrow/i);
  assert.match(content, /unsupported_by_host[\s\S]*supported local host[\s\S]*manually attach[\s\S]*path-free[\s\S]*no approval/i);
  assert.match(content, /`refused`[\s\S]*path-free[\s\S]*recovery\/next action[\s\S]*never exact-resolve or add/i);
  assert.match(content, /no_match\/no_registered_projects[\s\S]*project add preview/i);
  assert.match(content, /no_match\/concrete_action_required[\s\S]*concrete action[\s\S]*do not reconnect/i);
  assert.match(content, /other no-match[\s\S]*project list[\s\S]*add only if absent/i);
  assert.match(content, /durable memory[\s\S]*explicitly asks[\s\S]*selected scope/is);
  assert.match(content, /browser-only[\s\S]*cannot access[\s\S]*local folder[\s\S]*supported local agent/is);
});

test("the universal bridge isolates one approved native child and reports launch failure honestly", async () => {
  const content = await bridgeManagedBlock("/tmp/example-aios", {
    localCli: {
      executable: "/opt/dotaios/node/bin/node",
      entrypoint: "/opt/dotaios/package/packages/cli/src/index.mjs"
    }
  });

  assert.match(
    content,
    /exact success[\s\S]*fresh ephemeral[\s\S]*customer-hidden native child[\s\S]*rooted at[\s\S]*returned location[\s\S]*same visible task[\s\S]*no second visible task/i
  );
  assert.match(
    content,
    /carry only[\s\S]*higher-priority host authority[\s\S]*approved proposal[\s\S]*no prior project instructions[\s\S]*project memory[\s\S]*governing skill[\s\S]*working-directory binding[\s\S]*project-scoped tool state/i
  );
  assert.match(content, /native project instructions[\s\S]*not route approval[\s\S]*not product authority/i);
  assert.match(
    content,
    /host hierarchy and sandbox[\s\S]*credential access[\s\S]*software installation[\s\S]*out-of-project writes[\s\S]*external submission[\s\S]*different action/i
  );
  assert.match(content, /router[\s\S]*does not[\s\S]*semantic enforcement/i);
  assert.match(
    content,
    /native launch fails[\s\S]*manual opening[\s\S]*only[\s\S]*approved folder[\s\S]*must not claim success/i
  );
  assert.doesNotMatch(content, /project catalog|capability (?:id|catalog)|installer|updater|output pointer|per-agent (?:branch|flow)/i);
  assert.doesNotMatch(content, /if (?:this is |the host is )?(?:Codex|Claude|Gemini)|for (?:Codex|Claude|Gemini) hosts?/i);
});

test("a missing captured local entrypoint stops resolution with bounded re-activation guidance", async () => {
  const content = await bridgeManagedBlock("/tmp/example-aios", {
    localCli: {
      executable: "/opt/dotaios/node/bin/node",
      entrypoint: "/opt/dotaios/package/packages/cli/src/index.mjs"
    }
  });

  assert.match(content, /if (?:the )?captured executable or entrypoint is missing[\s\S]*stop/is);
  assert.match(content, /re-run activation from the same admitted local installation/i);
  assert.match(content, /do not substitute.*(?:package runner|registry|cache|bare command)/i);
});

// Regression guard for the defect this replaced: every documented install is
// `npx dotaios@<version>`, which links no binary onto PATH, so a bare `dotaios`
// in a bridge is an instruction the host answers with `command not found`. The
// same managed block forbids reading `memory/` directly as a fallback, so that
// one wrong word cost the agent its entire memory while `doctor` stayed green.
test("a bridge accepts only an exact candidate invocation", async () => {
  const withoutBinary = await bridgeManagedBlock("/tmp/example-aios", { cli: "npx dotaios@9.9.9" });
  assert.match(withoutBinary, /`npx dotaios@9\.9\.9 brief --compact --memory shared`/);
  assert.equal(
    /`dotaios /.test(withoutBinary),
    false,
    "no bare `dotaios ...` may survive when the machine has no such binary"
  );
  await assert.rejects(
    bridgeManagedBlock("/tmp/example-aios", { cli: "dotaios" }),
    /exact candidate/i
  );
});

test("the skills-first managed bridge contains no bare activation command", async () => {
  const content = await bridgeManagedBlock("/tmp/example-aios", {
    cli: "npx dotaios@9.9.9",
    skillsFirst: true,
    skillsCatalog: { indexText: "# Skills", resolverText: "# Resolver" }
  });

  assert.doesNotMatch(content, /`dotaios\s+[a-z]/);
  assert.doesNotMatch(content, /npx dotaios(?!@)/);
});

test("resolveCliInvocation always pins the exact candidate without probing PATH", async () => {
  let availabilityProbes = 0;
  assert.equal(
    await resolveCliInvocation({
      isAvailable: async () => {
        availabilityProbes += 1;
        return true;
      },
      version: "9.9.9"
    }),
    "npx dotaios@9.9.9"
  );
  assert.equal(availabilityProbes, 0, "managed invocation selection never consults PATH");
  await assert.rejects(
    resolveCliInvocation({ version: null }),
    /package version/i,
    "an unknown version must not silently select unpinned npm code"
  );
  await assert.rejects(
    resolveCliInvocation({ version: "latest" }),
    /package version/i,
    "a dist-tag must not masquerade as an exact package candidate"
  );
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
      managed.length < 6000,
      `${agent.name}: the always-loaded bridge and hidden handoff stay bounded (${managed.length} characters)`
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

// opencode.ai/docs/rules documents the global instructions file as
// `~/.config/opencode/AGENTS.md`, and states that "the first matching file wins
// in each category" -- instruction files are selected, not concatenated. With
// no bridge of its own, DotAIOS reached OpenCode only through its Claude Code
// compatibility fallback on `~/.claude/CLAUDE.md`, which a user turns off with
// OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1 and which loses to any nearer
// AGENTS.md. The vendor-native path is the one that survives both.
//
// The bridge is safe to declare because OpenCode carries `command: "opencode"`
// and a detect directory, and activate only writes a bridge for an agent
// isAgentInstalled confirms -- so setup never creates `~/.config/opencode` on a
// machine that does not run OpenCode, which is the trap that made Gemini
// manufacture the evidence for its own warning.
test("OpenCode's bridge lands on the instructions file OpenCode documents", async () => {
  const registry = await loadAgentRegistry();
  const opencode = registry.find((agent) => agent.name === "OpenCode");

  assert.ok(opencode);
  assert.equal(opencode.bridge, ".config/opencode/AGENTS.md");
  assert.equal(opencode.detect, ".config/opencode");
  assert.equal(opencode.command, "opencode");
  assert.equal(
    bridgePath("/tmp/home", opencode),
    "/tmp/home/.config/opencode/AGENTS.md"
  );
});
