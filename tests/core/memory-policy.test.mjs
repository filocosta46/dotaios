import test from "node:test";
import assert from "node:assert/strict";

import {
  MEMORY_MODES,
  resolveMemoryPolicy
} from "../../packages/core/src/memory-policy.mjs";

test("memory policy defaults to shared continuity", () => {
  assert.deepEqual(resolveMemoryPolicy(), {
    mode: "shared",
    projectSelector: null,
    receipt: "Memory: Shared",
    notice: null,
    reads: true,
    writes: true
  });
});

test("a project selector preserves compatibility by selecting strict project memory", () => {
  assert.deepEqual(resolveMemoryPolicy({ project: "project-acme-001" }), {
    mode: "project",
    projectSelector: "project-acme-001",
    receipt: "Memory: This project",
    notice: null,
    reads: true,
    writes: true
  });
});

test("private chat is anchored, case-insensitive, and always wins", () => {
  const policy = resolveMemoryPolicy({
    mode: "project",
    project: "project-acme-001",
    firstUserMessage: "  PRIVATE CHAT — do not use my memory"
  });
  assert.equal(policy.mode, "off");
  assert.equal(policy.projectSelector, null);
  assert.equal(policy.receipt, "Memory: Off");
  assert.equal(policy.reads, false);
  assert.equal(policy.writes, false);
  assert.match(policy.notice, /AI app may still keep its own conversation history/i);

  assert.equal(
    resolveMemoryPolicy({ firstUserMessage: "Please make this a private chat" }).mode,
    "shared",
    "the phrase only selects Off when it starts the first message"
  );
});

test("explicit Off cannot be re-enabled by a forwarded first-message phrase", () => {
  assert.equal(resolveMemoryPolicy({ mode: "off", firstUserMessage: "Use my memory now" }).mode, "off");
  assert.equal(resolveMemoryPolicy({ mode: "off", firstUserMessage: "Only this project", project: "alpha" }).mode, "off");
});

test("the first-message phrases select shared and project behavior", () => {
  assert.equal(resolveMemoryPolicy({
    project: "project-acme-001",
    firstUserMessage: "Use my memory for this"
  }).mode, "shared");
  assert.equal(resolveMemoryPolicy({
    project: "project-acme-001",
    firstUserMessage: "Only this project, please"
  }).mode, "project");
});

test("explicit project mode requires a selector and contradictory CLI inputs fail closed", () => {
  assert.throws(
    () => resolveMemoryPolicy({ mode: "project" }),
    /project selector is required/i
  );
  assert.throws(
    () => resolveMemoryPolicy({ mode: "shared", project: "project-acme-001" }),
    /cannot combine shared memory with a project selector/i
  );
});

test("memory policy rejects unknown modes and exposes only the three product choices", () => {
  assert.deepEqual(MEMORY_MODES, ["shared", "project", "off"]);
  assert.throws(() => resolveMemoryPolicy({ mode: "automatic" }), /memory mode/i);
});
