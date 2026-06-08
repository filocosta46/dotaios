import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureExternalSkillsDir } from "../../packages/core/src/hermes-config.mjs";

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

test("idempotent when path already present", async () => {
  const p = await writeCfg("skills:\n  external_dirs:\n    - /home/user/aios/skills\n");
  const res = await ensureExternalSkillsDir({ configPath: p, skillsPath: "/home/user/aios/skills" });
  assert.equal(res.action, "already-present");
});

test("appends to an existing block list", async () => {
  const p = await writeCfg("skills:\n  external_dirs:\n    - /other/skills\n");
  const res = await ensureExternalSkillsDir({ configPath: p, skillsPath: "/home/user/aios/skills" });
  assert.equal(res.action, "added");
  const out = await fs.readFile(p, "utf8");
  assert.match(out, /- \/other\/skills\n {4}- \/home\/user\/aios\/skills/);
});

test("substring path is NOT a false already-present", async () => {
  const p = await writeCfg("skills:\n  external_dirs:\n    - /home/user/aios/skills-backup\n");
  const res = await ensureExternalSkillsDir({ configPath: p, skillsPath: "/home/user/aios/skills" });
  assert.equal(res.action, "added");
});

test("fail-closed: no skills section → reports manual, file unchanged", async () => {
  const body = "model:\n  provider: openrouter\n";
  const p = await writeCfg(body);
  const res = await ensureExternalSkillsDir({ configPath: p, skillsPath: "/home/user/aios/skills" });
  assert.equal(res.action, "manual");
  assert.equal(await fs.readFile(p, "utf8"), body);
});
