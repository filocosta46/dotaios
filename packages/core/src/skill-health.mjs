import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPathWithinLexically } from "./paths.mjs";
import { MANAGED_END, MANAGED_START, isAgentInstalled, loadAgentRegistry } from "./bridges.mjs";
import { renderResolver, renderSkillsIndex, collectSkills } from "./skills.mjs";
import { symlinkTargets } from "./skill-targets.mjs";
import { discoverHermesConfigPaths } from "./hermes-config.mjs";
import { findManagedSkillAliases } from "./skills-install.mjs";

export async function inspectSkillHealth({ aiosPath, homePath = os.homedir() }) {
  const registry = await loadAgentRegistry(aiosPath);
  const sourceSkills = await collectSkills(aiosPath);
  const skillsDir = path.join(aiosPath, "skills");
  const catalogs = {
    index: await compareFile(
      path.join(skillsDir, "INDEX.md"),
      `${renderSkillsIndex(sourceSkills)}\n`
    ),
    resolver: await compareFile(
      path.join(skillsDir, "RESOLVER.md"),
      `${renderResolver(sourceSkills)}\n`
    )
  };

  const targets = [];
  for (const target of symlinkTargets(registry)) {
    const targetDir = path.join(homePath, target.dir);
    const active = await isSkillTargetActive(homePath, targetDir, registry);
    targets.push(await inspectSkillTarget({
      aiosPath,
      homePath,
      targetDir,
      sourceSkills,
      active
    }));
  }

  const bridges = await inspectBridges({ aiosPath, homePath });
  const hermes = await inspectHermes({ aiosPath, homePath, registry });
  const runtimes = await inspectRuntimes({ homePath, registry, targets, bridges, hermes });
  const issues = [];

  if (!catalogs.index.current) issues.push("skills/INDEX.md is missing or stale");
  if (!catalogs.resolver.current) issues.push("skills/RESOLVER.md is missing or stale");
  for (const target of targets) {
    if (target.status !== "active") continue;
    if (target.missing.length) issues.push(`${target.dir}: ${target.missing.length} source skill(s) missing`);
    if (target.broken.length) issues.push(`${target.dir}: ${target.broken.length} broken link(s)`);
    if (target.foreign.length) issues.push(`${target.dir}: ${target.foreign.length} unmanaged collision(s)`);
    if (target.aliases.length) issues.push(`${target.dir}: ${target.aliases.length} duplicate managed alias(es)`);
    if (target.stale.length) issues.push(`${target.dir}: ${target.stale.length} stale extra link(s)`);
    const unmanagedExtras = target.extra.filter((entry) => entry.kind !== "stale-owned");
    if (unmanagedExtras.length) issues.push(`${target.dir}: ${unmanagedExtras.length} unmanaged extra link(s)`);
  }
  for (const bridge of bridges) {
    if (bridge.status !== "healthy" && bridge.status !== "not-detected" && bridge.status !== "not-applicable") {
      issues.push(`${bridge.name} bridge is ${bridge.status}`);
    }
  }
  for (const entry of hermes.configs) {
    if (entry.status !== "healthy") issues.push(`${entry.path} does not expose the canonical skills directory`);
  }
  return {
    healthy: issues.length === 0,
    source: {
      path: skillsDir,
      count: sourceSkills.length
    },
    catalogs,
    targets,
    bridges,
    hermes,
    runtimes,
    verification: {
      scope: "configuration-only",
      invocation: "not-run",
      note: "A path-ready report does not prove that a client discovered or invoked a skill; run a bounded agent-specific smoke test for invocation evidence."
    },
    unsupported: [
      "Codex, Cursor, Gemini CLI, Kimi Code CLI, and OpenCode use the shared .agents/skills target; Antigravity IDE uses its documented global target.",
      "Surfaces without local Agent Skills discovery continue to use the DotAIOS bridge and resolver."
    ],
    issues
  };
}

async function inspectRuntimes({ homePath, registry, targets, bridges, hermes }) {
  const targetByDir = new Map(targets.map((target) => [target.dir, target]));
  const bridgeByName = new Map(bridges.map((bridge) => [bridge.name, bridge]));
  const rows = [];

  for (const agent of registry) {
    const installed = await isAgentInstalled(homePath, agent);
    const bridge = bridgeByName.get(agent.name);
    const configured = configuredStatus({ agent, installed, bridge, homePath, targetByDir, hermes });
    const discoverable = discoverableStatus({ agent, installed, bridge, homePath, targetByDir, hermes });
    const binary = installed
      ? await commandStatus(agent.command)
      : "not-detected";

    rows.push({
      name: agent.name,
      installed,
      capabilities: {
        configured,
        discoverable,
        binary,
        invocation: "not-run"
      },
      evidence: {
        bridge: bridge?.status || "not-detected",
        skillTarget: skillTargetEvidence(agent, targetByDir),
        hermesConfigs: hermesEvidence(agent, homePath, hermes)
      }
    });
  }
  return rows;
}

function configuredStatus({ agent, installed, bridge, homePath, targetByDir, hermes }) {
  if (bridge?.status === "healthy") return "yes";
  if (agent.skills?.mode === "symlink") {
    const target = targetByDir.get(agent.skills.dir);
    return target?.status === "active" ? "yes" : "no";
  }
  if (agent.skills?.mode === "config-external-dir") {
    const expected = path.resolve(homePath, agent.skills.configFile);
    return hermes.configs.some((entry) => entry.path === expected && entry.status === "healthy") ? "yes" : "no";
  }
  if (!installed) return "not-detected";
  return bridge?.status === "not-applicable" ? "not-declared" : "no";
}

function discoverableStatus({ agent, installed, bridge, targetByDir, hermes }) {
  if (agent.skills?.mode === "symlink") {
    const target = targetByDir.get(agent.skills.dir);
    if (!target || target.status !== "active") return installed ? "no" : "not-detected";
    return target.canonicalPresent ? "path-ready" : "no";
  }
  if (agent.skills?.mode === "config-external-dir") {
    return hermes.configs.length > 0 && hermes.configs.every((entry) => entry.status === "healthy")
      ? "path-ready"
      : (installed ? "no" : "not-detected");
  }
  if (bridge?.status === "healthy") return "not-proven";
  return installed ? "no" : "not-detected";
}

function skillTargetEvidence(agent, targetByDir) {
  if (agent.skills?.mode !== "symlink") return null;
  const target = targetByDir.get(agent.skills.dir);
  return target
    ? {
      path: target.path,
      status: target.status,
      complete: target.complete,
      canonicalPresent: target.canonicalPresent
    }
    : {
      path: agent.skills.dir,
      status: "not-detected",
      complete: false,
      canonicalPresent: null
    };
}

function hermesEvidence(agent, homePath, hermes) {
  if (agent.skills?.mode !== "config-external-dir") return [];
  const expected = path.resolve(homePath, agent.skills.configFile);
  return hermes.configs.filter((entry) => entry.path === expected).map((entry) => ({
    path: entry.path,
    status: entry.status
  }));
}

async function commandStatus(command) {
  if (!command) return "not-declared";
  const candidates = command.includes(path.sep) || path.isAbsolute(command)
    ? [command]
    : (process.env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, command));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return "available";
    } catch {
      // Try the next PATH entry.
    }
  }
  return "missing";
}

async function compareFile(filePath, expected) {
  try {
    const actual = await fs.readFile(filePath, "utf8");
    return { path: filePath, present: true, current: actual === expected };
  } catch {
    return { path: filePath, present: false, current: false };
  }
}

async function inspectSkillTarget({ aiosPath, homePath, targetDir, sourceSkills, active }) {
  const linked = [];
  const missing = [];
  const broken = [];
  const foreign = [];
  const aliases = await findManagedSkillAliases({ aiosPath, targetDir, skills: sourceSkills });
  const aliasPaths = new Set(aliases.map((entry) => entry.path));
  const extra = [];
  const stale = [];

  if (!active) {
    return {
      dir: path.relative(homePath, targetDir),
      path: targetDir,
      status: "not-detected",
      sourceCount: sourceSkills.length,
      linked,
      missing,
      broken,
      foreign,
      aliases: [],
      extra,
      stale,
      complete: true,
      canonicalPresent: null
    };
  }

  for (const skill of sourceSkills) {
    const source = path.resolve(path.join(aiosPath, "skills", skill.dir));
    const destination = path.join(targetDir, skill.dir);
    let stat;
    try {
      stat = await fs.lstat(destination);
    } catch {
      missing.push(skill.dir);
      continue;
    }

    if (!stat.isSymbolicLink()) {
      foreign.push({ skill: skill.dir, path: destination, kind: "real-entry" });
      continue;
    }

    const rawTarget = await fs.readlink(destination);
    const resolvedTarget = path.resolve(path.dirname(destination), rawTarget);
    try {
      await fs.access(destination);
    } catch {
      broken.push({ skill: skill.dir, path: destination, target: rawTarget });
      continue;
    }
    if (resolvedTarget === source) {
      linked.push(skill.dir);
      continue;
    }
    try {
      const [realSource, realDestination] = await Promise.all([
        fs.realpath(source),
        fs.realpath(destination)
      ]);
      if (realSource === realDestination) {
        linked.push(skill.dir);
        continue;
      }
    } catch {
      // A readable symlink that does not resolve to the canonical source is foreign.
    }
    foreign.push({ skill: skill.dir, path: destination, kind: "foreign-symlink", target: rawTarget });
  }

  const sourceNames = new Set(sourceSkills.map((skill) => skill.dir));
  try {
    const entries = await fs.readdir(targetDir, { withFileTypes: true });
    const sourceRoot = path.resolve(path.join(aiosPath, "skills"));
    for (const entry of entries) {
      if (sourceNames.has(entry.name) || !entry.isSymbolicLink()) continue;
      const destination = path.join(targetDir, entry.name);
      if (aliasPaths.has(destination)) continue;
      const rawTarget = await fs.readlink(destination);
      const resolvedTarget = path.resolve(path.dirname(destination), rawTarget);
      const owned = isPathWithinLexically(sourceRoot, resolvedTarget);
      let targetExists = true;
      try {
        await fs.access(resolvedTarget);
      } catch {
        targetExists = false;
      }
      const kind = !targetExists
        ? (owned ? "stale-owned" : "broken-foreign")
        : "foreign-symlink";
      const record = { path: destination, target: rawTarget, kind };
      extra.push(record);
      if (!targetExists) stale.push(record);
    }
  } catch {
    // A missing target directory is already represented by the source entries.
  }

  const hasUnmanagedExtras = extra.some((entry) => entry.kind !== "stale-owned");
  const canonicalPresent = linked.length === sourceSkills.length
    && missing.length === 0
    && broken.length === 0
    && foreign.length === 0;
  return {
    dir: path.relative(homePath, targetDir),
    path: targetDir,
    status: "active",
    sourceCount: sourceSkills.length,
    linked,
    missing,
    broken,
    foreign,
    aliases,
    extra,
    stale,
    canonicalPresent,
    complete: missing.length === 0
      && broken.length === 0
      && foreign.length === 0
      && aliases.length === 0
      && stale.length === 0
      && !hasUnmanagedExtras
  };
}

async function inspectBridges({ aiosPath, homePath }) {
  const registry = await loadAgentRegistry(aiosPath);
  const bridges = [];
  for (const agent of registry) {
    const installed = await isAgentInstalled(homePath, agent);
    if (!agent.bridge) {
      bridges.push({ name: agent.name, path: null, status: "not-applicable", installed, bridge: false });
      continue;
    }
    const bridgePath = path.join(homePath, agent.bridge);
    if (!installed) {
      bridges.push({ name: agent.name, path: bridgePath, status: "not-detected", installed: false });
      continue;
    }
    let content;
    try {
      content = await fs.readFile(bridgePath, "utf8");
    } catch {
      bridges.push({ name: agent.name, path: bridgePath, status: "missing", installed: true });
      continue;
    }
    const managed = content.includes(MANAGED_START) && content.includes(MANAGED_END);
    const status = !managed ? "unmanaged" : content.includes(aiosPath) ? "healthy" : "stale";
    bridges.push({ name: agent.name, path: bridgePath, status, installed: true });
  }
  return bridges;
}

async function inspectHermes({ aiosPath, homePath, registry = [] }) {
  const hermesRoot = path.join(homePath, ".hermes");
  const configPaths = await discoverHermesConfigPaths(homePath, registry);
  const hasConfigSurface = await pathExists(hermesRoot)
    || await Promise.all(configPaths.map((configPath) => pathExists(configPath)))
      .then((values) => values.some(Boolean));
  if (!hasConfigSurface) {
    return { available: false, canonical: path.resolve(path.join(aiosPath, "skills")), configs: [] };
  }

  const expected = path.resolve(path.join(aiosPath, "skills"));
  const configs = [];
  for (const configPath of configPaths) {
    const values = await readExternalDirs(configPath);
    if (!values) {
      configs.push({ path: configPath, status: "missing", externalDirs: [] });
      continue;
    }
    const externalDirs = values.map((value) => normalizePath(value, homePath));
    configs.push({
      path: configPath,
      status: externalDirs.includes(expected) ? "healthy" : "missing-canonical",
      externalDirs
    });
  }
  return { available: true, canonical: expected, configs };
}

async function isSkillTargetActive(homePath, targetDir, registry) {
  if (await pathExists(targetDir)) return true;
  const relative = path.relative(homePath, targetDir);
  const consumers = registry.filter(
    (agent) => agent.skills?.mode === "symlink" && agent.skills.dir === relative
  );
  if (consumers.length > 0) {
    const installed = await Promise.all(
      consumers.map((agent) => isAgentInstalled(homePath, agent))
    );
    return installed.some(Boolean);
  }
  return pathExists(path.dirname(targetDir));
}

async function pathExists(value) {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

async function readExternalDirs(configPath) {
  let text;
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const skillsIndex = lines.findIndex((line) => /^skills:\s*$/.test(line));
  if (skillsIndex === -1) return [];
  const externalIndex = lines.findIndex((line, index) =>
    index > skillsIndex && /^\S/.test(line) ? false : index > skillsIndex && /^\s{2}external_dirs:/.test(line)
  );
  if (externalIndex === -1) return [];
  const value = lines[externalIndex].replace(/^\s{2}external_dirs:\s*/, "").trim();
  if (!value) {
    const values = [];
    for (let index = externalIndex + 1; index < lines.length; index += 1) {
      const match = lines[index].match(/^\s+-\s+(.+)\s*$/);
      if (!match) break;
      values.push(unquoteScalar(match[1]));
    }
    return values;
  }
  if (value === "[]") return [];
  return [unquoteScalar(value)];
}

function normalizePath(value, homePath) {
  const normalized = unquoteScalar(value);
  if (normalized.startsWith("~")) return path.resolve(homePath, normalized.slice(1));
  return path.resolve(normalized);
}

function unquoteScalar(value) {
  return String(value || "").trim().replace(/^(['"])(.*)\1$/, "$2");
}
