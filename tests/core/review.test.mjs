import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { confirmWrites, previewWrite, renderPreview } from "../../packages/core/src/review.mjs";

async function makeTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "dotaios-review-"));
}

function captureLog() {
  const lines = [];
  return { log: { log: (line) => lines.push(line) }, lines };
}

function ttyInput(text) {
  const stream = Readable.from([text]);
  stream.isTTY = true;
  return stream;
}

function nonTtyInput(text = "") {
  const stream = Readable.from([text]);
  stream.isTTY = false;
  return stream;
}

function nullOutput() {
  return new Writable({ write(_chunk, _encoding, cb) { cb(); } });
}

test("previewWrite reports create action for new path", async () => {
  const dir = await makeTmp();
  const target = path.join(dir, "new.md");
  const preview = await previewWrite({ path: target, content: "hello\n" });
  assert.equal(preview.action, "create");
  assert.equal(preview.current, "");
  assert.equal(preview.next, "hello\n");
});

test("previewWrite reports update when content differs", async () => {
  const dir = await makeTmp();
  const target = path.join(dir, "existing.md");
  await fs.writeFile(target, "old\n");
  const preview = await previewWrite({ path: target, content: "new\n" });
  assert.equal(preview.action, "update");
});

test("previewWrite reports no change when content matches", async () => {
  const dir = await makeTmp();
  const target = path.join(dir, "same.md");
  await fs.writeFile(target, "same\n");
  const preview = await previewWrite({ path: target, content: "same\n" });
  assert.equal(preview.action, "no change");
});

test("renderPreview returns one line for no-change items", () => {
  const out = renderPreview({ path: "/x", action: "no change", current: "a", next: "a" });
  assert.equal(out, "[no change] /x");
});

test("confirmWrites auto-approves when flag is set", async () => {
  const dir = await makeTmp();
  const plan = [{ path: path.join(dir, "a.md"), content: "new\n" }];
  const { log, lines } = captureLog();
  const ok = await confirmWrites(plan, { autoApprove: true, log });
  assert.equal(ok, true);
  assert.ok(lines.some((line) => line.includes("Auto-approved")));
});

test("confirmWrites returns true with no work to do", async () => {
  const ok = await confirmWrites([], { log: { log: () => {} } });
  assert.equal(ok, true);
});

test("confirmWrites returns true when all entries are no-change", async () => {
  const dir = await makeTmp();
  const target = path.join(dir, "same.md");
  await fs.writeFile(target, "same\n");
  const ok = await confirmWrites([{ path: target, content: "same\n" }], { log: { log: () => {} } });
  assert.equal(ok, true);
});

test("confirmWrites throws in non-TTY without auto-approve", async () => {
  const dir = await makeTmp();
  const plan = [{ path: path.join(dir, "a.md"), content: "new\n" }];
  await assert.rejects(
    () => confirmWrites(plan, { input: nonTtyInput(), output: nullOutput(), log: { log: () => {} } }),
    /requires an interactive terminal/
  );
});

test("confirmWrites returns true for 'y' answer at TTY", async () => {
  const dir = await makeTmp();
  const plan = [{ path: path.join(dir, "a.md"), content: "new\n" }];
  const ok = await confirmWrites(plan, { input: ttyInput("y\n"), output: nullOutput(), log: { log: () => {} } });
  assert.equal(ok, true);
});

test("confirmWrites returns false for empty/n answer at TTY", async () => {
  const dir = await makeTmp();
  const plan = [{ path: path.join(dir, "a.md"), content: "new\n" }];
  const ok = await confirmWrites(plan, { input: ttyInput("\n"), output: nullOutput(), log: { log: () => {} } });
  assert.equal(ok, false);
});
