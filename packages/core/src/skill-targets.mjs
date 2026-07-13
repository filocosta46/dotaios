import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const registry = require("./agents.json");

// Dedup by `dir`. Includes per-agent symlink dirs + wellKnownSkillDirs.
export function symlinkTargets() {
  const seen = new Set();
  const out = [];
  const push = (t) => { if (t?.dir && !seen.has(t.dir)) { seen.add(t.dir); out.push({ dir: t.dir }); } };
  for (const a of registry.agents) if (a.skills?.mode === "symlink") push(a.skills);
  for (const w of registry.wellKnownSkillDirs || []) if (w.mode === "symlink") push(w);
  return out;
}

export function retiredSymlinkTargets() {
  return (registry.retiredSkillDirs || []).map((dir) => ({ dir }));
}

export function hermesConfigTargets() {
  return registry.agents
    .filter((a) => a.skills?.mode === "config-external-dir")
    .map((a) => ({ configFile: a.skills.configFile, key: a.skills.key }));
}
