import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import {
  discoverHermesConfigPaths,
  discoverHermesConfigTargets,
  ensureExternalSkillsDir,
  inspectExternalSkillsDirs
} from "../../packages/core/src/hermes-config.mjs";

async function writeCfg(body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-cfg-"));
  const p = path.join(dir, "config.yaml");
  await fs.writeFile(p, body);
  return p;
}

test("adds path to empty inline list `external_dirs: []`", async () => {
  const p = await writeCfg("model:\n  provider: openrouter\nskills:\n  external_dirs: []\n");
  const res = await ensureExternalSkillsDir({ configPath: p, skillsPath: "/home/user/aios/skills" });
  assert.equal(res.action, "added");
  const out = await fs.readFile(p, "utf8");
  assert.match(out, /external_dirs:\n {4}- \/home\/user\/aios\/skills/);
});

test("can create the skills section for a legacy Hermes profile", async () => {
  const p = await writeCfg("model:\n  provider: openai-codex\n");
  const res = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/Users/tester/aios/skills",
    createMissing: true
  });
  assert.equal(res.action, "added-section");
  assert.match(await fs.readFile(p, "utf8"), /skills:\n  external_dirs:\n    - \/Users\/tester\/aios\/skills/);
});

test("refuses a symlinked global config without touching its target", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-symlink-"));
  const configPath = path.join(root, "config.yaml");
  const targetPath = path.join(root, "outside.yaml");
  const body = "skills:\n  external_dirs: []\n";
  await fs.writeFile(targetPath, body);
  await fs.symlink(targetPath, configPath);

  const result = await ensureExternalSkillsDir({
    configPath,
    skillsPath: "/home/user/aios/skills",
    boundaryRoot: root
  });

  assert.equal(result.action, "manual");
  assert.match(result.reason, /not a regular file/);
  assert.equal((await fs.lstat(configPath)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(targetPath, "utf8"), body);
});

test("refuses a config reached through a symlinked parent directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-parent-symlink-"));
  const homePath = path.join(root, "home");
  const outsidePath = path.join(root, "outside-hermes");
  const configPath = path.join(homePath, ".hermes", "config.yaml");
  const targetPath = path.join(outsidePath, "config.yaml");
  const body = "skills:\n  external_dirs: []\n";
  await fs.mkdir(homePath);
  await fs.mkdir(outsidePath);
  await fs.writeFile(targetPath, body);
  await fs.symlink(outsidePath, path.join(homePath, ".hermes"));

  const result = await ensureExternalSkillsDir({
    configPath,
    skillsPath: "/home/user/aios/skills",
    boundaryRoot: homePath
  });

  assert.equal(result.action, "manual");
  assert.match(result.reason, /unsafe managed directory/);
  assert.equal(await fs.readFile(targetPath, "utf8"), body);
});

test("preserves a concurrent config edit instead of overwriting it", async () => {
  const body = "skills:\n  external_dirs: []\n";
  const concurrent = "skills:\n  external_dirs:\n    - /concurrent/skills\n";
  const p = await writeCfg(body);

  const result = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/home/user/aios/skills",
    boundaryRoot: path.dirname(p),
    beforeReplace: async () => {
      await fs.writeFile(p, concurrent);
    }
  });

  assert.equal(result.action, "conflict");
  assert.match(result.reason, /changed during activation/);
  assert.equal(await fs.readFile(p, "utf8"), concurrent);
});

test("serializes competing DotAIOS writers so only one reports success", async () => {
  const body = "skills:\n  external_dirs: []\n";
  const p = await writeCfg(body);
  let releaseFirst;
  let firstReachedRename;
  const reachedRename = new Promise((resolve) => { firstReachedRename = resolve; });
  const holdFirst = new Promise((resolve) => { releaseFirst = resolve; });

  const first = ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/first/skills",
    boundaryRoot: path.dirname(p),
    beforeRename: async () => {
      firstReachedRename();
      await holdFirst;
    }
  });
  await reachedRename;
  const second = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/second/skills",
    boundaryRoot: path.dirname(p)
  });
  releaseFirst();
  const firstResult = await first;

  assert.equal(firstResult.action, "added");
  assert.equal(second.action, "conflict");
  const output = await fs.readFile(p, "utf8");
  assert.match(output, /- \/first\/skills/);
  assert.doesNotMatch(output, /- \/second\/skills/);
  assert.deepEqual(
    (await fs.readdir(path.dirname(p))).filter((entry) => entry.endsWith(".dotaios-write.lock")),
    []
  );
});

test("rechecks ancestor containment immediately before replacement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-parent-race-"));
  const homePath = path.join(root, "home");
  const hermesPath = path.join(homePath, ".hermes");
  const movedPath = path.join(root, "moved-hermes");
  const configPath = path.join(hermesPath, "config.yaml");
  const body = "skills:\n  external_dirs: []\n";
  await fs.mkdir(hermesPath, { recursive: true });
  await fs.writeFile(configPath, body);

  const result = await ensureExternalSkillsDir({
    configPath,
    skillsPath: "/home/user/aios/skills",
    boundaryRoot: homePath,
    beforeRename: async () => {
      await fs.rename(hermesPath, movedPath);
      await fs.symlink(movedPath, hermesPath);
    }
  });

  assert.equal(result.action, "manual");
  assert.match(result.reason, /unsafe managed directory/);
  assert.equal(await fs.readFile(path.join(movedPath, "config.yaml"), "utf8"), body);
  assert.equal((await fs.lstat(hermesPath)).isSymbolicLink(), true);
});

test("fails closed on invalid UTF-8 without changing bytes or creating a backup", async () => {
  const p = await writeCfg(Buffer.concat([
    Buffer.from("skills:\n  external_dirs: []\n# user comment: "),
    Buffer.from([0xff]),
    Buffer.from("\n")
  ]));
  const before = await fs.readFile(p);

  const result = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/home/user/aios/skills",
    boundaryRoot: path.dirname(p)
  });

  assert.equal(result.action, "manual");
  assert.match(result.reason, /valid UTF-8/);
  assert.equal((await fs.readFile(p)).equals(before), true);
  assert.deepEqual(
    (await fs.readdir(path.dirname(p))).filter((entry) => entry.includes("dotaios-backup")),
    []
  );
});

test("dry-run and already-present paths reject a symlinked ancestor", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-read-symlink-"));
  const homePath = path.join(root, "home");
  const outsidePath = path.join(root, "outside-hermes");
  const configPath = path.join(homePath, ".hermes", "config.yaml");
  await fs.mkdir(homePath);
  await fs.mkdir(outsidePath);
  await fs.writeFile(
    path.join(outsidePath, "config.yaml"),
    "skills:\n  external_dirs:\n    - /home/user/aios/skills\n"
  );
  await fs.symlink(outsidePath, path.join(homePath, ".hermes"));

  for (const dryRun of [false, true]) {
    const result = await ensureExternalSkillsDir({
      configPath,
      skillsPath: "/home/user/aios/skills",
      boundaryRoot: homePath,
      dryRun
    });
    assert.equal(result.action, "manual");
    assert.match(result.reason, /unsafe managed directory/);
  }
});

test("rejects malformed dotted registry keys instead of normalizing them", async () => {
  const p = await writeCfg("runner:\n  skill_paths: []\n");
  const malformed = [
    "runner..skill_paths",
    ".runner.skill_paths",
    "runner.skill_paths.",
    "runner...skill_paths",
    "runner. skill_paths",
    "runner.\nskill_paths"
  ];

  for (const key of malformed) {
    const before = await fs.readFile(p);
    const inspection = await inspectExternalSkillsDirs(p, key, path.dirname(p));
    const activation = await ensureExternalSkillsDir({
      configPath: p,
      skillsPath: "/home/user/aios/skills",
      key,
      dryRun: true
    });
    assert.equal(inspection.status, "invalid-key", key);
    assert.equal(activation.action, "manual", key);
    assert.equal((await fs.readFile(p)).equals(before), true, key);
  }
});

test("ignores registry config targets with control characters without throwing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-invalid-target-"));
  const registry = [{
    name: "Invalid runtime",
    skills: {
      mode: "config-external-dir",
      configFile: ".bad\0/config.yaml",
      key: "runner.skill_paths"
    }
  }];

  const targets = await discoverHermesConfigTargets(root, registry);
  const inspection = await inspectExternalSkillsDirs("bad\0config.yaml", "runner.skill_paths", root);
  const activation = await ensureExternalSkillsDir({
    configPath: "bad\0config.yaml",
    skillsPath: "/home/user/aios/skills",
    key: "runner.skill_paths"
  });

  assert.deepEqual(targets, [{
    configPath: path.join(root, ".hermes", "config.yaml"),
    key: "skills.external_dirs"
  }]);
  assert.equal(inspection.status, "invalid-target");
  assert.equal(activation.action, "manual");
  assert.match(activation.reason, /unsafe config path/);
});

test("fails closed on a commented skills key instead of appending duplicate YAML keys", async () => {
  const body = "model: {}\nskills: # user-owned comment\n  enabled: true\n";
  const p = await writeCfg(body);

  const result = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/home/user/aios/skills",
    createMissing: true
  });

  assert.equal(result.action, "manual");
  assert.match(result.reason, /unsupported skills section spelling/);
  assert.equal(await fs.readFile(p, "utf8"), body);
});

test("fails closed on invalid YAML instead of editing an ambiguous document", async () => {
  const body = "skills:\n  external_dirs:\n    - /other/skills\nskills:\n  enabled: true\n";
  const p = await writeCfg(body);

  const result = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/home/user/aios/skills",
    createMissing: true
  });

  assert.equal(result.action, "manual");
  assert.match(result.reason, /invalid YAML/);
  assert.equal(await fs.readFile(p, "utf8"), body);
});

test("fails closed on a quoted external_dirs key instead of appending a semantic duplicate", async () => {
  const body = "skills:\n  'external_dirs':\n    - /other/skills\n";
  const p = await writeCfg(body);

  const result = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/home/user/aios/skills",
    createMissing: true
  });

  assert.equal(result.action, "manual");
  assert.match(result.reason, /unsupported external_dirs key spelling/);
  assert.equal(await fs.readFile(p, "utf8"), body);
});

test("recognizes an inline-commented canonical list entry without duplicating it", async () => {
  const body = "skills:\n  external_dirs:\n    - /home/user/aios/skills # shared with Hermes\n";
  const p = await writeCfg(body);

  const result = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/home/user/aios/skills"
  });

  assert.equal(result.action, "already-present");
  assert.equal(await fs.readFile(p, "utf8"), body);
});

test("recognizes an inline-commented canonical scalar without duplicating it", async () => {
  const body = "skills:\n  external_dirs: /home/user/aios/skills # shared with Hermes\n";
  const p = await writeCfg(body);

  const result = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/home/user/aios/skills"
  });

  assert.equal(result.action, "already-present");
  assert.equal(await fs.readFile(p, "utf8"), body);
});

test("fails closed on block scalar external_dirs instead of corrupting continuation lines", async () => {
  const body = "skills:\n  external_dirs: |\n    /other/skills\n";
  const p = await writeCfg(body);

  const result = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/home/user/aios/skills"
  });

  assert.equal(result.action, "manual");
  assert.match(result.reason, /unexpected external_dirs shape/);
  assert.equal(await fs.readFile(p, "utf8"), body);
});

test("fails closed on multiline quoted external_dirs instead of corrupting continuation lines", async () => {
  const body = "skills:\n  external_dirs: \"/other/skills\n    continued\"\n";
  const p = await writeCfg(body);

  const result = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/home/user/aios/skills"
  });

  assert.equal(result.action, "manual");
  assert.match(result.reason, /unexpected external_dirs shape/);
  assert.equal(await fs.readFile(p, "utf8"), body);
});

test("preserves comments before an indentless list and inserts valid YAML", async () => {
  const body = "skills:\n  external_dirs:\n  # keep this note\n  - /other/skills\n";
  const p = await writeCfg(body);

  const result = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/home/user/aios/skills"
  });
  const output = await fs.readFile(p, "utf8");
  const parsed = parseDocument(output, { strict: true, uniqueKeys: true });

  assert.equal(result.action, "added");
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(parsed.toJS().skills.external_dirs, [
    "/other/skills",
    "/home/user/aios/skills"
  ]);
  assert.match(output, /# keep this note/);
});

test("finds a canonical list item after preserved comment trivia", async () => {
  const body = "skills:\n  external_dirs:\n    # shared with Hermes\n    - /home/user/aios/skills\n";
  const p = await writeCfg(body);

  const result = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/home/user/aios/skills"
  });

  assert.equal(result.action, "already-present");
  assert.equal(await fs.readFile(p, "utf8"), body);
});

test("fails closed when lexical external_dirs text is not a semantic map key", async () => {
  for (const body of [
    "skills:\n  external_dirs:# user text\n",
    "skills:\n  external_dirs:[]# user text\n"
  ]) {
    const p = await writeCfg(body);
    const result = await ensureExternalSkillsDir({
      configPath: p,
      skillsPath: "/home/user/aios/skills"
    });

    assert.equal(result.action, "manual");
    assert.equal(await fs.readFile(p, "utf8"), body);
  }
});

test("fails closed on non-scalar and aliased sequence entries", async () => {
  for (const body of [
    "skills:\n  external_dirs:\n    - path: /other/skills\n",
    "shared: &shared /other/skills\nskills:\n  external_dirs:\n    - *shared\n"
  ]) {
    const p = await writeCfg(body);
    const result = await ensureExternalSkillsDir({
      configPath: p,
      skillsPath: "/home/user/aios/skills"
    });

    assert.equal(result.action, "manual");
    assert.match(result.reason, /unexpected external_dirs list shape/);
    assert.equal(await fs.readFile(p, "utf8"), body);
  }
});

test("quotes inserted paths whose YAML punctuation would change their value", async () => {
  for (const skillsPath of [
    "/home/user/skills # archive",
    "/home/user/skills: archive"
  ]) {
    const p = await writeCfg("skills:\n  external_dirs: []\n");
    const result = await ensureExternalSkillsDir({ configPath: p, skillsPath });
    const output = await fs.readFile(p, "utf8");
    const parsed = parseDocument(output, { strict: true, uniqueKeys: true });

    assert.equal(result.action, "added");
    assert.equal(parsed.errors.length, 0);
    assert.deepEqual(parsed.toJS().skills.external_dirs, [skillsPath]);
  }
});

test("escapes Unicode line separators and remains idempotent", async () => {
  for (const separator of ["\u2028", "\u2029"]) {
    const skillsPath = `/home/user/skills${separator}archive`;
    const p = await writeCfg("skills:\n  external_dirs: []\n");

    const first = await ensureExternalSkillsDir({ configPath: p, skillsPath });
    const afterFirst = await fs.readFile(p, "utf8");
    const second = await ensureExternalSkillsDir({ configPath: p, skillsPath });
    const parsed = parseDocument(afterFirst, { strict: true, uniqueKeys: true });

    assert.equal(first.action, "added");
    assert.equal(second.action, "already-present");
    assert.deepEqual(parsed.toJS().skills.external_dirs, [skillsPath]);
    assert.equal(await fs.readFile(p, "utf8"), afterFirst);
  }
});

test("fails closed on a multiline skills path", async () => {
  const body = "skills:\n  external_dirs: []\n";
  const p = await writeCfg(body);
  const result = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/home/user/skills\ninjected: true"
  });

  assert.equal(result.action, "manual");
  assert.match(result.reason, /unsafe skills path/);
  assert.equal(await fs.readFile(p, "utf8"), body);
});

test("preserves a commented empty list and is idempotent", async () => {
  const skillsPath = "/home/user/aios/skills";
  const p = await writeCfg("skills:\n  external_dirs: [] # keep this note\n");

  const first = await ensureExternalSkillsDir({ configPath: p, skillsPath });
  const afterFirst = await fs.readFile(p, "utf8");
  const second = await ensureExternalSkillsDir({ configPath: p, skillsPath });

  assert.equal(first.action, "added");
  assert.equal(second.action, "already-present");
  assert.match(afterFirst, /external_dirs: # keep this note/);
  assert.equal(await fs.readFile(p, "utf8"), afterFirst);
});

test("preserves CRLF line endings when editing a valid config", async () => {
  const p = await writeCfg("skills:\r\n  external_dirs:\r\n    - /other/skills\r\n");
  const result = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/home/user/aios/skills"
  });
  const output = await fs.readFile(p, "utf8");

  assert.equal(result.action, "added");
  assert.equal(output.replaceAll("\r\n", "").includes("\n"), false);
  assert.match(output, /- \/home\/user\/aios\/skills\r\n/);
});

test("discovers the root Hermes config and existing profile configs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-hermes-home-"));
  await fs.mkdir(path.join(root, ".hermes", "profiles", "legacy"), { recursive: true });
  await fs.writeFile(path.join(root, ".hermes", "config.yaml"), "model: {}\n");
  await fs.writeFile(path.join(root, ".hermes", "profiles", "legacy", "config.yaml"), "model: {}\n");
  const paths = await discoverHermesConfigPaths(root);
  assert.deepEqual(paths, [
    path.join(root, ".hermes", "config.yaml"),
    path.join(root, ".hermes", "profiles", "legacy", "config.yaml")
  ]);
});

test("idempotent when path already present", async () => {
  const p = await writeCfg("skills:\n  external_dirs:\n    - /home/user/aios/skills\n");
  const res = await ensureExternalSkillsDir({ configPath: p, skillsPath: "/home/user/aios/skills" });
  assert.equal(res.action, "already-present");
});

test("does not broaden global activation into duplicate normalization", async () => {
  const body = [
    "skills:",
    "  external_dirs:",
    "    - /home/user/aios/skills",
    "    - /home/user/aios/skills",
    ""
  ].join("\n");
  const p = await writeCfg(body);

  const result = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/home/user/aios/skills"
  });

  assert.equal(result.action, "already-present");
  assert.equal(await fs.readFile(p, "utf8"), body);
});

test("appends to an existing block list", async () => {
  const p = await writeCfg("skills:\n  external_dirs:\n    - /other/skills\n");
  const res = await ensureExternalSkillsDir({ configPath: p, skillsPath: "/home/user/aios/skills" });
  assert.equal(res.action, "added");
  const out = await fs.readFile(p, "utf8");
  assert.match(out, /- \/other\/skills\n {4}- \/home\/user\/aios\/skills/);
});

test("honors a registry-provided custom external skills key", async () => {
  const p = await writeCfg("runner:\n  skill_paths:\n    - /other/skills\n");
  const res = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/home/user/project/skills",
    key: "runner.skill_paths"
  });
  assert.equal(res.action, "added");
  assert.match(
    await fs.readFile(p, "utf8"),
    /skill_paths:\n {4}- \/other\/skills\n {4}- \/home\/user\/project\/skills/
  );
});

test("preserves Hermes profiles that indent external_dirs list items by two spaces", async () => {
  const existing = "/Users/tester/aios/skills";
  const p = await writeCfg([
    "skills:",
    "  external_dirs:",
    "  - /other/skills",
    ""
  ].join("\n"));

  const firstInstall = await ensureExternalSkillsDir({ configPath: p, skillsPath: existing });
  assert.equal(firstInstall.action, "added");
  assert.equal(
    await fs.readFile(p, "utf8"),
    [
      "skills:",
      "  external_dirs:",
      "  - /other/skills",
      `  - ${existing}`,
      ""
    ].join("\n")
  );

  const secondInstall = await ensureExternalSkillsDir({ configPath: p, skillsPath: existing });
  assert.equal(secondInstall.action, "already-present");
});

test("normalizes scalar external_dirs without mutating dry-runs or repeat installs", async () => {
  const body = "model:\n  provider: openrouter\nskills:\n  external_dirs: /Users/tester/aios/skills\n  enabled: true\nlogging:\n  level: info\n";
  const p = await writeCfg(body);
  const expected = "model:\n  provider: openrouter\nskills:\n  external_dirs:\n    - /Users/tester/aios/skills\n  enabled: true\nlogging:\n  level: info\n";

  const dryRun = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/Users/tester/aios/skills",
    dryRun: true,
  });
  assert.equal(dryRun.action, "would-add");
  assert.equal(await fs.readFile(p, "utf8"), body);

  const firstInstall = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/Users/tester/aios/skills",
  });
  assert.equal(firstInstall.action, "added");
  assert.equal(await fs.readFile(p, "utf8"), expected);

  const secondInstall = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/Users/tester/aios/skills",
  });
  assert.equal(secondInstall.action, "already-present");
  assert.equal(await fs.readFile(p, "utf8"), expected);
});

test("normalizes scalar external_dirs paths that contain spaces", async () => {
  const skillsPath = "/Users/tester/My AIOS/skills";
  const p = await writeCfg(`skills:\n  external_dirs: ${skillsPath}\n`);
  const res = await ensureExternalSkillsDir({ configPath: p, skillsPath });
  assert.equal(res.action, "added");
  assert.match(await fs.readFile(p, "utf8"), /- \/Users\/tester\/My AIOS\/skills/);
});

test("prunes missing DotAIOS temporary external dirs while preserving the canonical path", async () => {
  const stale = path.join(os.tmpdir(), "dotaios-setup-dead", "aios", "skills");
  const canonical = "/Users/tester/aios/skills";
  const p = await writeCfg([
    "skills:",
    "  external_dirs:",
    `    - ${canonical}`,
    `    - ${stale}`,
    "  template_vars: true",
    ""
  ].join("\n"));

  const res = await ensureExternalSkillsDir({ configPath: p, skillsPath: canonical });
  assert.equal(res.action, "pruned-stale");
  const out = await fs.readFile(p, "utf8");
  assert.match(out, new RegExp(`- ${canonical.replaceAll("/", "\\/")}`));
  assert.doesNotMatch(out, /dotaios-setup-dead/);
});

test("never prunes and reinserts the requested canonical path as stale temp state", async () => {
  const canonical = path.join(os.tmpdir(), "dotaios-canonical-missing", "aios", "skills");
  await fs.rm(path.join(os.tmpdir(), "dotaios-canonical-missing"), { recursive: true, force: true });
  const p = await writeCfg("skills:\n  external_dirs: []\n");

  const first = await ensureExternalSkillsDir({ configPath: p, skillsPath: canonical });
  const afterFirst = await fs.readFile(p, "utf8");
  const second = await ensureExternalSkillsDir({ configPath: p, skillsPath: canonical });

  assert.equal(first.action, "added");
  assert.equal(second.action, "already-present");
  assert.equal(await fs.readFile(p, "utf8"), afterFirst);
});

test("keeps a live DotAIOS-looking temporary external dir", async () => {
  const live = path.join(os.tmpdir(), "dotaios-live", "aios", "skills");
  await fs.mkdir(live, { recursive: true });
  const canonical = "/Users/tester/aios/skills";
  const p = await writeCfg([
    "skills:",
    "  external_dirs:",
    `    - ${live}`,
    ""
  ].join("\n"));

  const res = await ensureExternalSkillsDir({ configPath: p, skillsPath: canonical });
  assert.equal(res.action, "added");
  assert.match(await fs.readFile(p, "utf8"), new RegExp(live.replaceAll("/", "\\/")));
  await fs.rm(path.join(os.tmpdir(), "dotaios-live"), { recursive: true, force: true });
});

test("substring path is NOT a false already-present", async () => {
  const p = await writeCfg("skills:\n  external_dirs:\n    - /home/user/aios/skills-backup\n");
  const res = await ensureExternalSkillsDir({ configPath: p, skillsPath: "/home/user/aios/skills" });
  assert.equal(res.action, "added");
});

test("does not find the canonical path in a later YAML section", async () => {
  const canonical = "/Users/tester/aios/skills";
  const p = await writeCfg([
    "skills:",
    "  external_dirs:",
    "    - /other/skills",
    "logging:",
    `    - ${canonical}`,
    ""
  ].join("\n"));

  const res = await ensureExternalSkillsDir({ configPath: p, skillsPath: canonical });

  assert.equal(res.action, "added");
  const out = await fs.readFile(p, "utf8");
  assert.match(out, new RegExp(`external_dirs:[\\s\\S]*- ${canonical.replaceAll("/", "\\/")}`));
  assert.match(out, new RegExp(`logging:[\\s\\S]*- ${canonical.replaceAll("/", "\\/")}`));
});

test("fail-closed: no skills section → reports manual, file unchanged", async () => {
  const body = "model:\n  provider: openrouter\n";
  const p = await writeCfg(body);
  const res = await ensureExternalSkillsDir({ configPath: p, skillsPath: "/home/user/aios/skills" });
  assert.equal(res.action, "manual");
  assert.equal(await fs.readFile(p, "utf8"), body);
});
