import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluatePublishArtifact,
  publishDecision,
} from "../../scripts/release-checklist.mjs";

// pruneBundledDependencyJunk only runs inside pack:admission. A maintainer who
// types `npm publish` in the repo root re-packs whatever node_modules happens to
// hold, which is how a dependency's test suite reached the registry. The
// checklist is the last read-only gate before that command, so it has to look at
// the exact bytes about to be published and refuse the known-dirty shapes.

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const checklist = path.join(repoRoot, "scripts", "release-checklist.mjs");

const CLEAN_ENTRIES = Object.freeze([
  "package/package.json",
  "package/npm-shrinkwrap.json",
  "package/README.md",
  "package/packages/cli/src/index.mjs",
  "package/node_modules/turndown/lib/turndown.cjs.js",
]);

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function makeTarball(entries) {
  const chunks = [];
  for (const [name, content] of Object.entries(entries)) {
    const body = Buffer.from(content, "utf8");
    chunks.push(tarHeader(name, body.length), body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function packageContents(extra = {}) {
  return {
    "package/package.json": JSON.stringify({ name: "dotaios", version: "2.0.15" }),
    "package/npm-shrinkwrap.json": JSON.stringify({ lockfileVersion: 3, packages: {} }),
    "package/README.md": "# DotAIOS\n",
    ...extra,
  };
}

function writeArtifact(t, label, contents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dotaios-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifact = path.join(root, "dotaios-2.0.15.tgz");
  fs.writeFileSync(artifact, makeTarball(contents));
  return artifact;
}

function runChecklist(args) {
  return spawnSync(process.execPath, [checklist, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { PATH: path.dirname(process.execPath) },
  });
}

test("a clean artifact listing is admitted for publication", () => {
  const verdict = evaluatePublishArtifact(CLEAN_ENTRIES);
  assert.equal(verdict.publish_artifact, "ADMITTED");
  assert.deepEqual(verdict.refusals, []);
});

test("a bundled dependency test fixture refuses the artifact", () => {
  const verdict = evaluatePublishArtifact([
    ...CLEAN_ENTRIES,
    "package/node_modules/@mixmark-io/domino/test/fixture/jquery-1.9.1.js",
  ]);
  assert.equal(verdict.publish_artifact, "REFUSED");
  assert.equal(verdict.refusals.length, 1);
  assert.match(verdict.refusals[0], /jquery-1\.9\.1\.js/);
});

test("a bundled dependency test corpus refuses the artifact", () => {
  const verdict = evaluatePublishArtifact([
    ...CLEAN_ENTRIES,
    "package/node_modules/@mixmark-io/domino/test/html5lib-tests.json",
  ]);
  assert.equal(verdict.publish_artifact, "REFUSED");
  assert.match(verdict.refusals[0], /html5lib-tests\.json/);
});

test("an artifact without the frozen dependency graph refuses publication", () => {
  const verdict = evaluatePublishArtifact(
    CLEAN_ENTRIES.filter((entry) => entry !== "package/npm-shrinkwrap.json")
  );
  assert.equal(verdict.publish_artifact, "REFUSED");
  assert.match(verdict.refusals[0], /npm-shrinkwrap\.json/);
});

test("every dirty condition is reported at once rather than one per run", () => {
  const verdict = evaluatePublishArtifact([
    "package/package.json",
    "package/node_modules/@mixmark-io/domino/test/fixture/jquery-1.9.1.js",
    "package/node_modules/@mixmark-io/domino/test/html5lib-tests.json",
  ]);
  assert.equal(verdict.publish_artifact, "REFUSED");
  assert.equal(verdict.refusals.length, 3);
});

test("publication needs both a GO admission and an admitted artifact", () => {
  assert.equal(publishDecision("GO", "ADMITTED").go, true);
  assert.equal(publishDecision("GO", "REFUSED").go, false);
  assert.equal(publishDecision("GO", "NOT PROVIDED").go, false);
  assert.equal(publishDecision("NO-GO", "ADMITTED").go, false);
});

test("the checklist refuses a dirty pack and never prints a publish command", (t) => {
  const artifact = writeArtifact(t, "dirty-artifact", packageContents({
    "package/node_modules/@mixmark-io/domino/test/fixture/jquery-1.9.1.js": "// jquery\n",
  }));

  const result = runChecklist(["--artifact", artifact]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(result.stdout, /Publish artifact: REFUSED/);
  assert.match(result.stdout, /jquery-1\.9\.1\.js/);
  assert.doesNotMatch(result.stdout, /npm publish/i);
});

test("the checklist refuses a pack that lost its frozen dependency graph", (t) => {
  const contents = packageContents();
  delete contents["package/npm-shrinkwrap.json"];
  const artifact = writeArtifact(t, "unfrozen-artifact", contents);

  const result = runChecklist(["--artifact", artifact]);

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Publish artifact: REFUSED/);
  assert.match(result.stdout, /npm-shrinkwrap\.json/);
  assert.doesNotMatch(result.stdout, /npm publish/i);
});

test("a clean pack is admitted even while the release itself stays NO-GO", (t) => {
  const artifact = writeArtifact(t, "clean-artifact", packageContents());

  const result = runChecklist(["--artifact", artifact]);

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Publish artifact: ADMITTED/);
  assert.match(result.stdout, /Public-release admission: NO-GO/);
  assert.doesNotMatch(result.stdout, /npm publish/i);
});

test("an unadmitted pack is reported rather than silently skipped", () => {
  const result = runChecklist([]);

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Publish artifact: NOT PROVIDED/);
  assert.doesNotMatch(result.stdout, /npm publish/i);
});

test("the release runbook sends the maintainer to the admitted tarball", async () => {
  const runbook = await fs.promises.readFile(
    path.join(repoRoot, ".claude", "commands", "release-check.md"),
    "utf8"
  );
  assert.match(runbook, /--artifact/);
  assert.match(runbook, /npm publish <[^>]*\.tgz>|npm publish .*admitted/i);
  assert.doesNotMatch(runbook, /npm publish\s*$/m);
});

test("inherited Object members are not option names", () => {
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const result = runChecklist([name, "value"]);
    assert.equal(result.status, 1, `${name}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /Unknown option/, name);
  }
});
