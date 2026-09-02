import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  projectSymlinkTargets,
  retiredSymlinkTargets,
  symlinkTargets
} from "../../packages/core/src/skill-targets.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

function markdownSection(document, heading, level = 3) {
  const marker = `${"#".repeat(level)} ${heading}`;
  const start = document.indexOf(marker);
  assert.notEqual(start, -1, `INSTALL.md must contain ${marker}`);
  const bodyStart = start + marker.length;
  const nextHeading = new RegExp(`^#{1,${level}}\\s`, "m");
  const remainder = document.slice(bodyStart);
  const match = nextHeading.exec(remainder);
  return match ? remainder.slice(0, match.index) : remainder;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function tableDirectories(section) {
  return Array.from(
    section.matchAll(/^\|[^|\n]+\|\s*`([^`\n]+)`\s*\|$/gm),
    (match) => match[1]
  );
}

function retiredDirectories(section) {
  return Array.from(
    section.matchAll(/`((?:~|<checkout>)\/\.[^`]+)`/g),
    (match) => match[1]
  );
}

test("removal guide stays bound to the active and retired client registry", async () => {
  const install = await fs.readFile(path.join(repoRoot, "INSTALL.md"), "utf8");
  const removal = markdownSection(install, "Disconnect or remove", 2);
  const activeGlobal = markdownSection(removal, "Active global skill directories");
  const activeProject = markdownSection(removal, "Active project skill directories");
  const retired = markdownSection(removal, "Retired skill directories");

  assert.deepEqual(
    sorted(tableDirectories(activeGlobal)),
    sorted(symlinkTargets().map(({ dir }) => `~/${dir}`))
  );
  assert.deepEqual(
    sorted(tableDirectories(activeProject)),
    sorted(projectSymlinkTargets().map(({ dir }) => `<checkout>/${dir}`))
  );
  assert.deepEqual(
    sorted(retiredDirectories(retired)),
    sorted(retiredSymlinkTargets().flatMap(({ dir }) => [
      `~/${dir}`,
      `<checkout>/${dir}`
    ]))
  );

  for (const { dir } of symlinkTargets()) {
    assert.doesNotMatch(
      retired,
      new RegExp(escapeRegExp(dir)),
      `${dir} is active and must never be described as retired`
    );
  }
});

test("removal guide classifies the complete current machine-local state root", async () => {
  const install = await fs.readFile(path.join(repoRoot, "INSTALL.md"), "utf8");
  const removal = markdownSection(install, "Disconnect or remove", 2);
  const machineState = markdownSection(removal, "Machine-local state");
  const expectedEntries = [
    "~/.dotaios/projects.json",
    "~/.dotaios/sync.json",
    "~/.dotaios/sync.lock",
    "~/.dotaios/managed-skills",
    "~/.dotaios/project-sources",
    "~/.dotaios/bin/lightpanda",
    "~/.dotaios/.lightpanda_hint_shown"
  ];

  const documentedEntries = Array.from(
    machineState.matchAll(/`(~\/\.dotaios\/[^`]+)`/g),
    (match) => match[1]
  );
  assert.deepEqual(sorted(documentedEntries), sorted(expectedEntries));
  const unwrapped = machineState.replace(/\s+/g, " ");
  assert.match(unwrapped, /For .*Remove.* only.*classify each current owned entry/i);
  assert.match(unwrapped, /Disconnect.* keeps the project and source registry entries/i);
  assert.match(unwrapped, /remove `~\/\.dotaios` only when it is empty/i);
  assert.match(unwrapped, /preserve.*unexpected entr/i);
  assert.doesNotMatch(machineState, /rm\s+-rf\s+~\/\.dotaios/i);
});
