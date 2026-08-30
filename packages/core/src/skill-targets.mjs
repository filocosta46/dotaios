import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const bundledRegistry = require("./agents.json");

export const SKILL_TARGET_PLAN_FORMAT = "dotaios-skill-target-plan/v1";

function agentsFrom(registry) {
  return Array.isArray(registry)
    ? registry
    : (registry?.agents || bundledRegistry.agents || []);
}

function wellKnownFrom(registry) {
  return registry?.wellKnownSkillDirs || bundledRegistry.wellKnownSkillDirs || [];
}

function retiredFrom(registry) {
  return registry?.retiredSkillDirs || bundledRegistry.retiredSkillDirs || [];
}

function projectFrom(agent) {
  return agent?.skills?.project || null;
}

function projectWellKnownFrom(registry) {
  return (registry?.wellKnownSkillDirs || bundledRegistry.wellKnownSkillDirs || [])
    .map((target) => target?.project)
    .filter(Boolean);
}

// Dedup by `dir`. Includes per-agent symlink dirs + wellKnownSkillDirs.
export function symlinkTargets(registry = bundledRegistry) {
  const seen = new Set();
  const out = [];
  const push = (t) => { if (t?.dir && !seen.has(t.dir)) { seen.add(t.dir); out.push({ dir: t.dir }); } };
  for (const a of agentsFrom(registry)) if (a.skills?.mode === "symlink") push(a.skills);
  for (const w of wellKnownFrom(registry)) if (w.mode === "symlink") push(w);
  return out;
}

export function planSkillTargets({
  registry = bundledRegistry,
  detectedAgentNames = new Set(),
  all = false
} = {}) {
  const detected = new Set(
    [...(detectedAgentNames || [])].map((name) => String(name).toLowerCase())
  );
  const grouped = new Map();
  const add = (target, scope, hosts = []) => {
    if (target?.mode !== "symlink" || !target.dir) return;
    const dir = String(target.dir).replaceAll("\\", "/");
    const current = grouped.get(dir) || {
      dir,
      scope,
      hosts: new Set()
    };
    if (scope === "shared") current.scope = "shared";
    for (const host of hosts) if (host) current.hosts.add(host);
    grouped.set(dir, current);
  };

  for (const target of wellKnownFrom(registry)) {
    add(target, "shared", target.serves || []);
  }
  for (const agent of agentsFrom(registry)) {
    if (!all && !detected.has(String(agent?.name || "").toLowerCase())) continue;
    add(agent.skills, "client-specific", [agent.name]);
  }

  const targets = [...grouped.values()]
    .map(({ dir, scope, hosts }) => Object.freeze({
      dir,
      scope,
      hosts: Object.freeze([...hosts].sort((left, right) => left.localeCompare(right)))
    }))
    .sort((left, right) => left.dir.localeCompare(right.dir));
  return Object.freeze({
    format: SKILL_TARGET_PLAN_FORMAT,
    mode: all ? "all" : "detected",
    targets: Object.freeze(targets)
  });
}

export function retiredSymlinkTargets(registry = bundledRegistry) {
  return retiredFrom(registry).map((dir) => ({ dir }));
}

export function hermesConfigTargets(registry = bundledRegistry) {
  return agentsFrom(registry)
    .filter((a) => a.skills?.mode === "config-external-dir")
    .map((a) => ({ configFile: a.skills.configFile, key: a.skills.key }));
}

// Project-local targets are explicit so a client can have a different
// project discovery path from its global discovery path. Do not infer these
// from the global target: custom adapters must opt in deliberately.
export function projectSymlinkTargets(registry = bundledRegistry) {
  const seen = new Set();
  const out = [];
  const push = (target) => {
    if (target?.mode !== "symlink" || !target.dir || seen.has(target.dir)) return;
    seen.add(target.dir);
    out.push({ dir: target.dir });
  };
  for (const agent of agentsFrom(registry)) push(projectFrom(agent));
  for (const target of projectWellKnownFrom(registry)) push(target);
  return out;
}
