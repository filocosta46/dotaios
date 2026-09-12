import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const script = fileURLToPath(new URL("../../scripts/skill-drift.mjs", import.meta.url));

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-skill-drift-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function skill(root, name) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), "# Fixture skill\n");
  return directory;
}

function run(home, extraRoots = []) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  const result = spawnSync(process.execPath, [script, ...extraRoots], {
    env,
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout;
}

test("skill drift deduplicates linked skills before reporting name collisions and root visibility", (t) => {
  const home = fixture(t);
  const claude = path.join(home, ".claude", "skills");
  const agents = path.join(home, ".agents", "skills");
  const extra = path.join(home, "extra-private-root");
  const review = skill(claude, "review");
  fs.mkdirSync(agents, { recursive: true });
  fs.symlinkSync(review, path.join(agents, "review"), "dir");
  fs.symlinkSync(review, path.join(agents, "review-alias"), "dir");
  skill(extra, "review");
  fs.mkdirSync(path.join(extra, "not-a-skill"));
  fs.writeFileSync(path.join(extra, "README.md"), "Not a skill.\n");

  const output = run(home, [extra]);

  assert.match(output, /Raw skill entries: 4\n/);
  assert.match(output, /Distinct skills \(realpaths\): 2\n/);
  assert.match(output, /Distinct names: 2\n/);
  assert.match(output, /Name collisions \(1\): review \(2\)\n/);
  assert.match(output, /Claude: 1 raw, 1 distinct/);
  assert.match(output, /Agents: 2 raw, 1 distinct/);
  assert.match(output, /Extra 1: 1 raw, 1 distinct/);
  assert.match(output, /review: Claude, Agents; review-alias: Agents/);
  assert.match(output, /review: Extra 1/);
  assert.ok(!output.includes(home), "pasteable output must not reveal the fixture home");
  assert.ok(!output.includes("extra-private-root"), "custom roots use ordinal labels");
  assert.ok(!output.includes("not-a-skill"));
});

test("skill drift reports broken roots and entries as unreadable without losing readable skills", (t) => {
  const home = fixture(t);
  const claude = path.join(home, ".claude", "skills");
  skill(claude, "audit");
  fs.symlinkSync(path.join(home, "missing-target"), path.join(claude, "broken"), "dir");
  fs.mkdirSync(path.join(home, ".factory"));
  fs.symlinkSync(path.join(home, "missing-root"), path.join(home, ".factory", "skills"), "dir");
  fs.mkdirSync(path.join(home, ".gemini"));
  fs.writeFileSync(path.join(home, ".gemini", "skills"), "Not a directory.\n");

  const output = run(home);

  assert.match(output, /Distinct skills \(realpaths\): 1\n/);
  assert.match(output, /Claude: 1 raw, 1 distinct; partial; 2 entries checked; 1 unreadable/);
  assert.match(output, /Factory: 0 raw, 0 distinct; unreadable/);
  assert.match(output, /Gemini: 0 raw, 0 distinct; unreadable/);
  assert.match(output, /Agents: 0 raw, 0 distinct; missing/);
  assert.match(output, /Coverage: partial; counts are lower bounds/);
  assert.ok(!output.includes(home));
});

test("skill drift caps enumeration before filtering entries and labels a truncated survey", (t) => {
  const home = fixture(t);
  const claude = path.join(home, ".claude", "skills");
  const agents = path.join(home, ".agents", "skills");
  for (let index = 0; index < 513; index += 1) skill(claude, `skill-${index}`);
  fs.mkdirSync(agents, { recursive: true });
  for (let index = 0; index < 512; index += 1) fs.writeFileSync(path.join(agents, `file-${index}`), "");

  const output = run(home).split("\n\nVisibility")[0];

  assert.match(output, /Raw skill entries: 512\n/);
  assert.match(output, /Claude: 512 raw, 512 distinct; limited; 512 entries checked/);
  assert.match(output, /Agents: 0 raw, 0 distinct; complete; 512 entries checked/);
  assert.match(output, /Entry cap per root: 512; no recursive scan/);
  assert.match(output, /Coverage: partial; counts are lower bounds/);
});

test("skill drift reports permission-denied roots and does not recurse into containers", {
  skip: process.platform === "win32" || process.getuid?.() === 0 ? "Requires Unix directory permissions" : false,
}, (t) => {
  const home = fixture(t);
  const claude = path.join(home, ".claude", "skills");
  const agents = path.join(home, ".agents", "skills");
  skill(claude, "audit");
  skill(path.join(agents, "container"), "nested-skill");
  fs.chmodSync(claude, 0o000);
  let output;
  try {
    output = run(home);
  } finally {
    fs.chmodSync(claude, 0o700);
  }

  assert.match(output, /Claude: 0 raw, 0 distinct; unreadable/);
  assert.match(output, /Agents: 0 raw, 0 distinct; complete; 1 entries checked/);
  assert.match(output, /Distinct skills \(realpaths\): 0\n/);
  assert.ok(!output.includes("nested-skill"));
});

test("skill drift keeps unusual skill names on one output line", {
  skip: process.platform === "win32" ? "Windows forbids control characters in file names" : false,
}, (t) => {
  const home = fixture(t);
  const name = "review\nINJECTED";
  skill(path.join(home, ".claude", "skills"), name);
  skill(path.join(home, ".agents", "skills"), name);

  const output = run(home);

  assert.match(output, /Name collisions \(1\): "review\\nINJECTED" \(2\)\n/);
  assert.ok(!output.includes("\nINJECTED"));
  assert.match(output, /"review\\nINJECTED": Claude/);
});

test("skill drift bounds collision names in the summary while preserving complete visibility", (t) => {
  const home = fixture(t);
  for (let index = 0; index < 13; index += 1) {
    const name = `collision-${String(index).padStart(2, "0")}`;
    skill(path.join(home, ".claude", "skills"), name);
    skill(path.join(home, ".agents", "skills"), name);
  }

  const output = run(home);
  const [summary, visibility] = output.split("\n\nVisibility");
  const collisions = summary.split("\n").find((line) => line.startsWith("Name collisions"));

  assert.match(summary, /Distinct skills \(realpaths\): 26\n/);
  assert.match(collisions, /^Name collisions \(13\): collision-00 \(2\), /);
  assert.match(collisions, /collision-11 \(2\), and 1 more$/);
  assert.ok(!collisions.includes("collision-12"));
  assert.match(visibility, /collision-12: Claude/);
  assert.match(visibility, /collision-12: Agents/);
});
