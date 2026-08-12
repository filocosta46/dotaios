import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const bundledRegistry = require("./agents.json");

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
