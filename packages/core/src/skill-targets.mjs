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
