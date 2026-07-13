import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MANAGED_END, MANAGED_START, isAgentInstalled, loadAgentRegistry } from "./bridges.mjs";
import { renderResolver, renderSkillsIndex, collectSkills } from "./skills.mjs";
import { symlinkTargets } from "./skill-targets.mjs";

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
    const active = await isSkillTargetActive(homePath, targetDir);
    targets.push(await inspectSkillTarget({
      aiosPath,
      homePath,
      targetDir,
      sourceSkills,
      active
    }));
  }

  const bridges = await inspectBridges({ aiosPath, homePath });
  const hermes = await inspectHermes({ aiosPath, homePath });
  const issues = [];

  if (!catalogs.index.current) issues.push("skills/INDEX.md is missing or stale");
  if (!catalogs.resolver.current) issues.push("skills/RESOLVER.md is missing or stale");
  for (const target of targets) {
    if (target.status !== "active") continue;
    if (target.missing.length) issues.push(`${target.dir}: ${target.missing.length} source skill(s) missing`);
    if (target.broken.length) issues.push(`${target.dir}: ${target.broken.length} broken link(s)`);
    if (target.foreign.length) issues.push(`${target.dir}: ${target.foreign.length} unmanaged collision(s)`);
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
    unsupported: [
      "Codex, Cursor, and Gemini use the shared .agents/skills target; Antigravity uses its documented global target.",
      "Surfaces without local Agent Skills discovery continue to use the DotAIOS bridge and resolver."
    ],
    issues
  };
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
      extra,
      stale,
      complete: true
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
      const rawTarget = await fs.readlink(destination);
      const resolvedTarget = path.resolve(path.dirname(destination), rawTarget);
      const owned = isWithin(sourceRoot, resolvedTarget);
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
  return {
    dir: path.relative(homePath, targetDir),
    path: targetDir,
    status: "active",
    sourceCount: sourceSkills.length,
    linked,
    missing,
    broken,
    foreign,
    extra,
    stale,
    complete: missing.length === 0
      && broken.length === 0
      && foreign.length === 0
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

async function inspectHermes({ aiosPath, homePath }) {
  const hermesRoot = path.join(homePath, ".hermes");
  if (!await pathExists(hermesRoot)) {
    return { available: false, canonical: path.resolve(path.join(aiosPath, "skills")), configs: [] };
  }
  const configPaths = [];
  const root = path.join(hermesRoot, "config.yaml");
  configPaths.push(root);
  try {
    const entries = await fs.readdir(path.join(hermesRoot, "profiles"), { withFileTypes: true });
    for (const entry of entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      configPaths.push(path.join(hermesRoot, "profiles", entry.name, "config.yaml"));
    }
  } catch {
    // No Hermes installation is a valid discovery result, not a thrown error.
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

async function isSkillTargetActive(homePath, targetDir) {
  if (await pathExists(targetDir)) return true;
  const relative = path.relative(homePath, targetDir);
  if (relative === ".claude/skills") return pathExists(path.join(homePath, ".claude"));
  if (relative === ".agents/skills") {
    const agentHomes = [".codex", ".cursor", ".gemini", ".antigravity", ".vscode", ".warp"];
    return (await Promise.all(agentHomes.map((dir) => pathExists(path.join(homePath, dir)))).then((values) => values.some(Boolean)));
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

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
