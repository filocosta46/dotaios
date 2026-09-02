import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPathWithinLexically } from "./paths.mjs";
import {
  MANAGED_END,
  MANAGED_START,
  bridgePath,
  isAgentInstalled,
  isCommandAvailable,
  loadAgentRegistry,
  resolveClaudeConfigRoot
} from "./bridges.mjs";
import { collectSkills, renderResolverBytes, renderSkillsIndexBytes } from "./skills.mjs";
import { symlinkTargets } from "./skill-targets.mjs";
import { discoverHermesConfigTargets, inspectExternalSkillsDirs } from "./hermes-config.mjs";
import { findManagedSkillAliases } from "./skills-install.mjs";

export async function inspectSkillHealth({ aiosPath, homePath = os.homedir(), detection = {} }) {
  const registry = await loadAgentRegistry(aiosPath);
  const sourceSkills = await collectSkills(aiosPath);
  const skillsDir = path.join(aiosPath, "skills");
  const catalogs = {
    index: await compareFile(
      path.join(skillsDir, "INDEX.md"),
      renderSkillsIndexBytes(sourceSkills)
    ),
    resolver: await compareFile(
      path.join(skillsDir, "RESOLVER.md"),
      renderResolverBytes(sourceSkills)
    )
  };

  const targets = [];
  for (const target of symlinkTargets(registry)) {
    const targetDir = target.dir.replaceAll("\\", "/") === ".claude/skills"
      ? path.join(resolveClaudeConfigRoot(homePath, { env: detection?.env ?? process.env }), "skills")
      : path.join(homePath, target.dir);
    const active = await isSkillTargetActive(homePath, targetDir, registry, detection, target.dir);
    targets.push(await inspectSkillTarget({
      aiosPath,
      homePath,
      declaredDir: target.dir,
      targetDir,
      sourceSkills,
      active
    }));
  }

  const bridges = await inspectBridges({ aiosPath, homePath, detection });
  const hermes = await inspectHermes({ aiosPath, homePath, registry });
  const runtimes = await inspectRuntimes({ homePath, registry, targets, bridges, hermes, detection });
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
      scope: "configuration-and-projection-only",
      invocation: "not-run",
      produced: "not-run",
      note: "A projected path does not prove that a client discovered, invoked, or produced with a skill; run a bounded agent-specific probe for stronger evidence."
    },
    unsupported: [
      "Codex, Cursor, Gemini CLI, Kimi Code CLI, and OpenCode use the shared .agents/skills target; Antigravity IDE uses its documented global target.",
      "Surfaces without local Agent Skills discovery continue to use the DotAIOS bridge and resolver."
    ],
    issues
  };
}

async function inspectRuntimes({ homePath, registry, targets, bridges, hermes, detection }) {
  const targetByDir = new Map(targets.map((target) => [target.dir, target]));
  const bridgeByName = new Map(bridges.map((bridge) => [bridge.name, bridge]));
  const rows = [];

  for (const agent of registry) {
    const installed = await isAgentInstalled(homePath, agent, detection);
    const bridge = bridgeByName.get(agent.name);
    const configured = configuredStatus({ agent, installed, bridge, homePath, targetByDir, hermes });
    const projected = projectedStatus({ agent, installed, bridge, homePath, targetByDir, hermes });
    const binary = installed
      ? await commandStatus(agent.command, detection)
      : "not-detected";

    rows.push({
      name: agent.name,
      installed,
      capabilities: {
        configured,
        projected,
        discoverable: "not-probed",
        binary,
        invocation: "not-run",
        produced: "not-run"
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
    const key = agent.skills.key || "skills.external_dirs";
    return hermes.configs.some((entry) => (
      entry.path === expected && entry.key === key && entry.status === "healthy"
    )) ? "yes" : "no";
  }
  if (!installed) return "not-detected";
  return bridge?.status === "not-applicable" ? "not-declared" : "no";
}

function projectedStatus({ agent, installed, bridge, homePath, targetByDir, hermes }) {
  if (agent.skills?.mode === "symlink") {
    const target = targetByDir.get(agent.skills.dir);
    if (!target || target.status !== "active") return installed ? "no" : "not-detected";
    return target.canonicalPresent ? "yes" : "no";
  }
  if (agent.skills?.mode === "config-external-dir") {
    const expected = path.resolve(homePath, agent.skills.configFile);
    const key = agent.skills.key || "skills.external_dirs";
    const target = hermes.configs.find((entry) => entry.path === expected && entry.key === key);
    return target?.status === "healthy" ? "yes" : (installed ? "no" : "not-detected");
  }
  if (bridge?.status === "healthy") return "not-applicable";
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
      canonicalPresent: target.canonicalPresent,
      linkedCount: target.linked.length,
      sourceCount: target.sourceCount
    }
    : {
      path: agent.skills.dir,
      status: "not-detected",
      complete: false,
      canonicalPresent: null,
      linkedCount: 0,
      sourceCount: null
    };
}

function hermesEvidence(agent, homePath, hermes) {
  if (agent.skills?.mode !== "config-external-dir") return [];
  const expected = path.resolve(homePath, agent.skills.configFile);
  const key = agent.skills.key || "skills.external_dirs";
  return hermes.configs.filter((entry) => entry.path === expected && entry.key === key).map((entry) => ({
    path: entry.path,
    key: entry.key,
    status: entry.status
  }));
}

async function commandStatus(command, detection) {
  if (!command) return "not-declared";
  return await isCommandAvailable(command, detection) ? "available" : "missing";
}

async function compareFile(filePath, expected) {
  try {
    const actual = await fs.readFile(filePath);
    return { path: filePath, present: true, current: actual.equals(expected) };
  } catch {
    return { path: filePath, present: false, current: false };
  }
}

async function inspectSkillTarget({ aiosPath, homePath, declaredDir, targetDir, sourceSkills, active }) {
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
      dir: declaredDir ?? path.relative(homePath, targetDir),
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
    dir: declaredDir ?? path.relative(homePath, targetDir),
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

async function inspectBridges({ aiosPath, homePath, detection }) {
  const registry = await loadAgentRegistry(aiosPath);
  const bridges = [];
  for (const agent of registry) {
    const installed = await isAgentInstalled(homePath, agent, detection);
    if (!agent.bridge) {
      bridges.push({ name: agent.name, path: null, status: "not-applicable", installed, bridge: false });
      continue;
    }
    const agentBridgePath = bridgePath(homePath, agent, {
      env: detection?.env ?? process.env
    });
    if (!installed) {
      bridges.push({ name: agent.name, path: agentBridgePath, status: "not-detected", installed: false });
      continue;
    }
    let content;
    try {
      content = await fs.readFile(agentBridgePath, "utf8");
    } catch {
      bridges.push({ name: agent.name, path: agentBridgePath, status: "missing", installed: true });
      continue;
    }
    const managed = content.includes(MANAGED_START) && content.includes(MANAGED_END);
    const status = !managed ? "unmanaged" : content.includes(aiosPath) ? "healthy" : "stale";
    bridges.push({ name: agent.name, path: agentBridgePath, status, installed: true });
  }
  return bridges;
}

async function inspectHermes({ aiosPath, homePath, registry = [] }) {
  const hermesRoot = path.join(homePath, ".hermes");
  const configTargets = await discoverHermesConfigTargets(homePath, registry);
  const hasConfigSurface = await pathExists(hermesRoot)
    || await Promise.all(configTargets.map(({ configPath }) => pathExists(configPath)))
      .then((values) => values.some(Boolean));
  if (!hasConfigSurface) {
    return { available: false, canonical: path.resolve(path.join(aiosPath, "skills")), configs: [] };
  }

  const expected = path.resolve(path.join(aiosPath, "skills"));
  const configs = [];
  for (const { configPath, key } of configTargets) {
    const inspection = await inspectExternalSkillsDirs(configPath, key, homePath);
    if (inspection.status === "missing") {
      configs.push({ path: configPath, key, status: "missing", externalDirs: [] });
      continue;
    }
    if (inspection.status !== "readable") {
      configs.push({ path: configPath, key, status: inspection.status, externalDirs: [] });
      continue;
    }
    const values = inspection.values;
    const externalDirs = values.map((value) => normalizeHermesPath(value, homePath));
    configs.push({
      path: configPath,
      key,
      status: externalDirs.includes(expected) ? "healthy" : "missing-canonical",
      externalDirs
    });
  }
  return { available: true, canonical: expected, configs };
}

async function isSkillTargetActive(homePath, targetDir, registry, detection, declaredDir = null) {
  if (await pathExists(targetDir)) return true;
  const relative = declaredDir ?? path.relative(homePath, targetDir);
  const consumers = registry.filter(
    (agent) => agent.skills?.mode === "symlink" && agent.skills.dir === relative
  );
  if (consumers.length > 0) {
    const installed = await Promise.all(
      consumers.map((agent) => isAgentInstalled(homePath, agent, detection))
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

function normalizeHermesPath(value, homePath) {
  const normalized = String(value || "").trim();
  if (normalized === "~") return path.resolve(homePath);
  if (normalized.startsWith(`~${path.sep}`) || normalized.startsWith("~/")) {
    return path.resolve(homePath, normalized.slice(2));
  }
  if (path.isAbsolute(normalized)) return path.resolve(normalized);
  return path.resolve(homePath, ".hermes", normalized);
}
