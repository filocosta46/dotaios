import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSessionDigest } from "../../packages/core/src/digest.mjs";
import {
  createContainedReadBudget,
  readContainedDirectory,
  readContainedFile
} from "../../packages/core/src/contained-read.mjs";
import { inspectMigrationState } from "../../packages/core/src/migrations.mjs";
import {
  buildWorkingContextEnvelope,
  renderOperationalNotice
} from "../../packages/core/src/working-context-envelope.mjs";

test("Off returns a fixed safe envelope before digest or migration inspection", async () => {
  let digestCalls = 0;
  let migrationCalls = 0;

  const envelope = await buildWorkingContextEnvelope(
    "/canonical/aios/must-not-be-opened",
    { memory: "off" },
    {
      buildSessionDigest: async () => {
        digestCalls += 1;
        throw new Error("Off built a digest");
      },
      inspectMigrationState: async () => {
        migrationCalls += 1;
        throw new Error("Off inspected migration state");
      },
    },
  );

  assert.equal(digestCalls, 0);
  assert.equal(migrationCalls, 0);
  assert.equal(envelope.memoryMode, "off");
  assert.equal(
    envelope.digest,
    "Memory: Off\n\nDotAIOS is off; your AI app may still keep its own conversation history. DotAIOS did not read, search, save, or capture this turn.",
  );
  assert.equal(envelope.notice, null);
});

test("the operational envelope keeps the canonical digest and budget unchanged", async (t) => {
  const aiosPath = await makeAios(t, "1.1.0");
  await fs.mkdir(path.join(aiosPath, "context"), { recursive: true });
  await fs.writeFile(path.join(aiosPath, "context", "identity.md"), "# Identity\n\nExact canonical body.\n");

  const digest = await buildSessionDigest(aiosPath, { visibleCharacterBudget: 256 });
  const envelope = await buildWorkingContextEnvelope(aiosPath, { visibleCharacterBudget: 256 });

  assert.equal(envelope.digest, digest.digest);
  assert.deepEqual(envelope.budget, digest.budget);
  assert.equal(envelope.operational.migration.status, "schema_outdated");
  assert.match(envelope.notice, /schema 1\.1\.0.*1\.2\.0/s);
  assert.doesNotMatch(envelope.digest, /\[DotAIOS\]|schema_outdated|dotaios migrate/);
  assert.ok(envelope.notice.length < 512);
});

test("the envelope forwards its injected filesystem to migration inspection", async (t) => {
  const aiosPath = await makeAios(t, "1.2.0");
  let openedConfig = false;
  const recordingFilesystem = proxyFilesystem({
    async open(candidate, flags) {
      if (candidate === path.join(aiosPath, "aios.json")) openedConfig = true;
      return fs.open(candidate, flags);
    }
  });

  await buildWorkingContextEnvelope(aiosPath, {}, {
    filesystem: recordingFilesystem,
    buildSessionDigest: async () => ({
      digest: "## Active Context\n",
      budget: { limit: 6000, used: 18, truncated: false },
      generatedAt: "2099-01-01T00:00:00.000Z",
      projectFilter: null
    })
  });

  assert.equal(openedConfig, true);
});

test("the cheap migration inspector reports current, stale, and transaction state", async (t) => {
  const current = await makeAios(t, "1.2.0");
  assert.deepEqual(await inspectMigrationState({ aiosPath: current }), {
    status: "current",
    folder_schema_version: "1.2.0",
    supported_schema_version: "1.2.0"
  });
  await fs.mkdir(path.join(current, ".dotaios", "migrations"), { recursive: true });
  assert.equal(
    (await inspectMigrationState({ aiosPath: current })).status,
    "current",
    "an empty metadata directory must preserve authoritative preview semantics"
  );

  const stale = await makeAios(t, "1.1.0");
  assert.deepEqual(await inspectMigrationState({ aiosPath: stale }), {
    status: "schema_outdated",
    folder_schema_version: "1.1.0",
    supported_schema_version: "1.2.0"
  });

  const interrupted = await makeAios(t, "1.2.0");
  await makeInterruptedTransaction(interrupted, "migrate-1_1_0-to-1_2_0-0123456789abcdef");
  assert.deepEqual(await inspectMigrationState({ aiosPath: interrupted }), {
    status: "transaction_present",
    folder_schema_version: "1.2.0",
    supported_schema_version: "1.2.0"
  });
});

test("a session-start migration inspection never reads protected memory shelves", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX permission probe");
  const aiosPath = await makeAios(t, "1.1.0");
  const protectedDir = path.join(aiosPath, "memory");
  await fs.mkdir(protectedDir);
  await fs.writeFile(path.join(protectedDir, "must-not-read.txt"), "private bytes\n");
  await fs.chmod(protectedDir, 0o000);
  try {
    const state = await inspectMigrationState({ aiosPath });
    assert.equal(state.status, "schema_outdated");
  } finally {
    await fs.chmod(protectedDir, 0o700);
  }
});

test("migration inspection performs bounded metadata I/O independent of protected shelf size", async (t) => {
  const aiosPath = await makeAios(t, "1.1.0");
  const protectedDir = path.join(aiosPath, "memory", "bulk");
  await fs.mkdir(protectedDir, { recursive: true });
  await Promise.all(Array.from({ length: 512 }, (_, index) => (
    fs.writeFile(path.join(protectedDir, `${index}.txt`), "private\n")
  )));

  const calls = [];
  const recordingFilesystem = recordingFilesystemFor(calls);

  const state = await inspectMigrationState({ aiosPath }, { filesystem: recordingFilesystem });
  assert.equal(state.status, "schema_outdated");
  assert.ok(calls.length <= 48, `expected bounded inspection I/O, received ${calls.length} calls`);
  assert.equal(
    calls.some((call) => call.some((value) => value.includes(`${path.sep}memory${path.sep}`))),
    false,
    "the compatibility inspector must not touch protected memory"
  );
});

test("migration inspection keeps maximum transaction metadata work bounded", async (t) => {
  const aiosPath = await makeAios(t, "1.2.0");
  for (let index = 0; index < 16; index += 1) {
    await makeInterruptedTransaction(
      aiosPath,
      `migrate-1_1_0-to-1_2_0-${index.toString(16).padStart(16, "0")}`
    );
  }
  const calls = [];
  const recordingFilesystem = recordingFilesystemFor(calls);

  const state = await inspectMigrationState({ aiosPath }, { filesystem: recordingFilesystem });
  assert.equal(state.status, "transaction_present");
  assert.ok(calls.length <= 184, `expected bounded maximum-state I/O, received ${calls.length} calls`);
  assert.equal(calls.filter(([operation]) => operation === "opendir").length, 2);
  assert.equal(
    calls.some((call) => call.some((value) => value.includes(`${path.sep}memory${path.sep}`))),
    false
  );

  const overflow = await makeAios(t, "1.2.0");
  for (let index = 0; index < 17; index += 1) {
    await makeInterruptedTransaction(
      overflow,
      `migrate-1_1_0-to-1_2_0-${index.toString(16).padStart(16, "0")}`
    );
  }
  const overflowCalls = [];
  await assert.rejects(
    inspectMigrationState({ aiosPath: overflow }, { filesystem: recordingFilesystemFor(overflowCalls) }),
    (error) => error?.code === "TOO_MANY_TRANSACTIONS"
  );
  assert.ok(overflowCalls.length <= 80, `overflow inspection did not stop early: ${overflowCalls.length} calls`);
});

test("migration inspection enforces exact config and ownership metadata caps", async (t) => {
  const oneMiB = 1024 * 1024;
  const exact = await makeAios(t, "1.2.0");
  await fs.writeFile(path.join(exact, "aios.json"), configBytes(oneMiB));
  assert.equal((await inspectMigrationState({ aiosPath: exact })).status, "current");

  const oversized = await makeAios(t, "1.2.0");
  await fs.writeFile(path.join(oversized, "aios.json"), configBytes(oneMiB + 1));
  await assert.rejects(
    inspectMigrationState({ aiosPath: oversized }),
    (error) => error?.code === "CONFIG_TOO_LARGE"
  );

  const ownerOversized = await makeAios(t, "1.2.0");
  const migrationsRoot = path.join(ownerOversized, ".dotaios", "migrations");
  await fs.mkdir(migrationsRoot, { recursive: true });
  await fs.writeFile(path.join(migrationsRoot, "owner.json"), Buffer.alloc(4097, 0x61));
  await assert.rejects(
    inspectMigrationState({ aiosPath: ownerOversized }),
    (error) => error?.code === "UNSAFE_METADATA"
  );
});

test("bounded contained reads never allocate a file that grows after the opened-size check", async (t) => {
  const aiosPath = await makeAios(t, "1.2.0");
  const target = path.join(aiosPath, "bounded.txt");
  await fs.writeFile(target, "12345678");
  let readFileCalled = false;
  let maximumRequestedBytes = 0;
  let grew = false;

  const racingFilesystem = proxyFilesystem({
    async open(candidate, flags) {
      const handle = await fs.open(candidate, flags);
      if (candidate !== target) return handle;
      return new Proxy(handle, {
        get(targetHandle, property) {
          if (property === "readFile") {
            return async () => {
              readFileCalled = true;
              if (!grew) {
                grew = true;
                await fs.appendFile(target, Buffer.alloc(1024 * 1024, 0x61));
              }
              return targetHandle.readFile();
            };
          }
          if (property === "read") {
            return async (buffer, offset, length, position) => {
              if (!grew) {
                grew = true;
                await fs.appendFile(target, Buffer.alloc(1024 * 1024, 0x61));
              }
              maximumRequestedBytes = Math.max(maximumRequestedBytes, length);
              return targetHandle.read(buffer, offset, length, position);
            };
          }
          const value = Reflect.get(targetHandle, property, targetHandle);
          return typeof value === "function" ? value.bind(targetHandle) : value;
        }
      });
    }
  });

  await assert.rejects(
    readContainedFile(aiosPath, target, {
      filesystem: racingFilesystem,
      maxBytes: 8,
      tooLargeCode: "TEST_TOO_LARGE"
    }),
    (error) => error?.code === "TEST_TOO_LARGE"
  );
  assert.equal(grew, true);
  assert.equal(readFileCalled, false, "a bounded path must not call unbounded handle.readFile");
  assert.ok(maximumRequestedBytes <= 9, `requested ${maximumRequestedBytes} bytes for an 8-byte limit`);
});

test("contained file and aggregate budgets accept the exact boundary and refuse one byte more", async (t) => {
  const aiosPath = await makeAios(t, "1.2.0");
  const exactPath = path.join(aiosPath, "exact.txt");
  const oversizedPath = path.join(aiosPath, "oversized.txt");
  await fs.writeFile(exactPath, "12345678");
  await fs.writeFile(oversizedPath, "123456789");

  assert.equal(
    await readContainedFile(aiosPath, exactPath, { encoding: "utf8", maxBytes: 8 }),
    "12345678"
  );
  await assert.rejects(
    readContainedFile(aiosPath, oversizedPath, {
      encoding: "utf8",
      maxBytes: 8,
      tooLargeCode: "TEST_TOO_LARGE"
    }),
    (error) => error?.code === "TEST_TOO_LARGE"
  );

  const budget = createContainedReadBudget({ maxBytes: 16, maxFiles: 2, maxEntries: 3 });
  budget.reserveFile(8);
  budget.reserveFile(8);
  budget.reserveEntries(3);
  assert.deepEqual(budget.snapshot(), { bytes: 16, files: 2, entries: 3 });
  assert.throws(
    () => budget.reserveFile(1),
    (error) => error?.code === "DOTAIOS_PROJECTION_READ_BUDGET_EXCEEDED"
  );
  assert.throws(
    () => budget.reserveEntries(1),
    (error) => error?.code === "DOTAIOS_PROJECTION_READ_BUDGET_EXCEEDED"
  );
  assert.deepEqual(budget.snapshot(), { bytes: 16, files: 2, entries: 3 });
});

test("canonical projection rejects an oversized source without an unbounded handle read", async (t) => {
  const aiosPath = await makeAios(t, "1.2.0");
  const identityPath = path.join(aiosPath, "context", "identity.md");
  await fs.mkdir(path.dirname(identityPath), { recursive: true });
  await fs.writeFile(identityPath, Buffer.alloc(2 * 1024 * 1024, 0x61));
  let handleReadFileCalled = false;
  let bytesRequested = 0;
  const filesystem = proxyFilesystem({
    async open(candidate, flags) {
      const handle = await fs.open(candidate, flags);
      if (candidate !== identityPath) return handle;
      return new Proxy(handle, {
        get(targetHandle, property) {
          if (property === "readFile") {
            return async () => {
              handleReadFileCalled = true;
              return targetHandle.readFile();
            };
          }
          if (property === "read") {
            return async (buffer, offset, length, position) => {
              bytesRequested += length;
              return targetHandle.read(buffer, offset, length, position);
            };
          }
          const value = Reflect.get(targetHandle, property, targetHandle);
          return typeof value === "function" ? value.bind(targetHandle) : value;
        }
      });
    }
  });

  await assert.rejects(
    buildSessionDigest(aiosPath, {}, { filesystem }),
    (error) => error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
  );
  assert.equal(handleReadFileCalled, false);
  assert.ok(bytesRequested <= 1024 * 1024 + 1, `projection requested ${bytesRequested} source bytes`);
});

test("canonical projection enforces one aggregate raw-byte budget", async (t) => {
  const aiosPath = await makeAios(t, "1.2.0");
  const identityPath = path.join(aiosPath, "context", "identity.md");
  const sessionsPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
  const eventsPath = path.join(aiosPath, "memory", "events.jsonl");
  await fs.mkdir(path.dirname(identityPath), { recursive: true });
  await fs.mkdir(path.dirname(sessionsPath), { recursive: true });
  await fs.writeFile(identityPath, Buffer.alloc(1024 * 1024, 0x61));
  await fs.writeFile(sessionsPath, Buffer.alloc(8 * 1024 * 1024, 0x20));
  await fs.writeFile(eventsPath, Buffer.alloc(8 * 1024 * 1024, 0x20));
  const before = new Map([
    [identityPath, await fs.readFile(identityPath)],
    [sessionsPath, await fs.readFile(sessionsPath)],
    [eventsPath, await fs.readFile(eventsPath)]
  ]);

  await assert.rejects(
    buildSessionDigest(aiosPath),
    (error) => error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
  );
  for (const [filePath, bytes] of before) assert.deepEqual(await fs.readFile(filePath), bytes);
});

test("canonical projection bounds project and signal directory enumeration", async (t) => {
  await t.test("project entries", async (subtest) => {
    const aiosPath = await makeAios(subtest, "1.2.0");
    const projectsPath = path.join(aiosPath, "projects");
    await fs.mkdir(projectsPath);
    await Promise.all(Array.from({ length: 257 }, (_, index) => (
      fs.mkdir(path.join(projectsPath, `project-${String(index).padStart(3, "0")}`))
    )));

    await assert.rejects(
      buildSessionDigest(aiosPath),
      (error) => error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
    );
  });

  await t.test("signal directory entries", async (subtest) => {
    const aiosPath = await makeAios(subtest, "1.2.0");
    const signalsPath = path.join(aiosPath, "memory", "signals");
    await fs.mkdir(signalsPath, { recursive: true });
    const fakeEntries = Array.from(
      { length: 8_193 },
      (_, index) => `archive-${String(index).padStart(4, "0")}-2000-01-01.jsonl`
    );
    let unboundedReaddirCalled = false;
    const filesystem = proxyFilesystem({
      async opendir(candidate) {
        if (candidate !== signalsPath) return fs.opendir(candidate);
        let index = 0;
        return {
          async read() {
            if (index >= fakeEntries.length) return null;
            const name = fakeEntries[index];
            index += 1;
            return { name };
          },
          async close() {}
        };
      },
      async readdir(candidate, options) {
        if (candidate !== signalsPath) return fs.readdir(candidate, options);
        unboundedReaddirCalled = true;
        return fakeEntries;
      }
    });

    await assert.rejects(
      buildSessionDigest(aiosPath, {}, { filesystem }),
      (error) => error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
    );
    assert.equal(unboundedReaddirCalled, false, "bounded signal discovery must use incremental opendir");
  });

  await t.test("signal files selected for the operational window", async (subtest) => {
    const aiosPath = await makeAios(subtest, "1.2.0");
    const signalsPath = path.join(aiosPath, "memory", "signals");
    await fs.mkdir(signalsPath, { recursive: true });
    const fakeEntries = Array.from(
      { length: 65 },
      (_, index) => `host-${String(index).padStart(3, "0")}-2099-01-01.jsonl`
    );
    const filesystem = proxyFilesystem({
      async opendir(candidate) {
        if (candidate !== signalsPath) return fs.opendir(candidate);
        let index = 0;
        return {
          async read() {
            if (index >= fakeEntries.length) return null;
            const name = fakeEntries[index];
            index += 1;
            return { name };
          },
          async close() {}
        };
      }
    });

    await assert.rejects(
      buildSessionDigest(aiosPath, {}, {
        clock: () => new Date("2099-01-01T12:00:00Z"),
        filesystem
      }),
      (error) => error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
    );
  });
});

test("contained file reads fail closed when handle identity is unavailable", async (t) => {
  const aiosPath = await makeAios(t, "1.2.0");
  const target = path.join(aiosPath, "context.txt");
  await fs.writeFile(target, "private context\n");
  let pathReadCalled = false;
  const filesystem = new Proxy(fs, {
    get(targetFilesystem, property) {
      if (property === "open") return undefined;
      if (property === "readFile") {
        return async (...args) => {
          pathReadCalled = true;
          return fs.readFile(...args);
        };
      }
      const value = Reflect.get(targetFilesystem, property, targetFilesystem);
      return typeof value === "function" ? value.bind(targetFilesystem) : value;
    }
  });

  await assert.rejects(
    readContainedFile(aiosPath, target, { filesystem, encoding: "utf8" }),
    (error) => error?.code === "DOTAIOS_FILE_HANDLE_READ_UNAVAILABLE"
  );
  assert.equal(pathReadCalled, false);
});

test("bounded directory reads fail closed when incremental enumeration is unavailable", async (t) => {
  const aiosPath = await makeAios(t, "1.2.0");
  const directoryPath = path.join(aiosPath, "bounded-directory");
  await fs.mkdir(directoryPath);
  await fs.writeFile(path.join(directoryPath, "one"), "1");
  let readdirCalled = false;
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property === "opendir") return undefined;
      if (property === "readdir") {
        return async (...args) => {
          readdirCalled = true;
          return fs.readdir(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  await assert.rejects(
    readContainedDirectory(aiosPath, directoryPath, { filesystem, maxEntries: 1 }),
    (error) => error?.code === "DOTAIOS_BOUNDED_DIRECTORY_READ_UNAVAILABLE"
  );
  assert.equal(readdirCalled, false);
});

test("inspection failure stays structured, path-free, and does not take down the digest", async (t) => {
  const aiosPath = await makeAios(t, "not-a-version");
  const envelope = await buildWorkingContextEnvelope(aiosPath);

  assert.match(envelope.digest, /## Active Context/);
  assert.deepEqual(envelope.operational.migration, {
    status: "inspection_failed",
    code: "INVALID_SCHEMA",
    severity: "warning",
    action: { command: "dotaios doctor", path_scope: "configured_aios" }
  });
  assert.match(renderOperationalNotice(envelope.operational), /dotaios doctor/);
  assert.doesNotMatch(JSON.stringify(envelope.operational), new RegExp(escapeRegExp(aiosPath)));
});

test("future, unsupported, invalid-encoding, and excessive transaction state fail closed with bounded codes", async (t) => {
  const fixtures = [
    ["future", "9.0.0", "FUTURE_SCHEMA"],
    ["unsupported", "0.9.0", "UNSUPPORTED_SCHEMA"]
  ];
  for (const [name, version, code] of fixtures) {
    await t.test(name, async (subtest) => {
      const aiosPath = await makeAios(subtest, version);
      const envelope = await buildWorkingContextEnvelope(aiosPath);
      assert.deepEqual(envelope.operational.migration, {
        status: "inspection_failed",
        code,
        severity: "warning",
        action: { command: "dotaios doctor", path_scope: "configured_aios" }
      });
      assert.ok(envelope.notice.length < 512);
    });
  }

  await t.test("invalid UTF-8", async (subtest) => {
    const aiosPath = await makeAios(subtest, "1.2.0");
    const configPath = path.join(aiosPath, "aios.json");
    const bytes = Buffer.concat([
      Buffer.from('{"schema_version":"1.2.0","note":"'),
      Buffer.from([0xff]),
      Buffer.from('"}\n')
    ]);
    await fs.writeFile(configPath, bytes);
    const envelope = await buildWorkingContextEnvelope(aiosPath);
    assert.deepEqual(envelope.operational.migration, {
      status: "inspection_failed",
      code: "INVALID_CONFIG_ENCODING",
      severity: "warning",
      action: { command: "dotaios doctor", path_scope: "configured_aios" }
    });
    assert.deepEqual(await fs.readFile(configPath), bytes);
  });

  await t.test("too many transaction entries", async (subtest) => {
    const aiosPath = await makeAios(subtest, "1.2.0");
    for (let index = 0; index < 17; index += 1) {
      await makeInterruptedTransaction(
        aiosPath,
        `migrate-1_1_0-to-1_2_0-${index.toString(16).padStart(16, "0")}`
      );
    }
    const envelope = await buildWorkingContextEnvelope(aiosPath);
    assert.deepEqual(envelope.operational.migration, {
      status: "inspection_failed",
      code: "TOO_MANY_TRANSACTIONS",
      severity: "warning",
      action: { command: "dotaios doctor", path_scope: "configured_aios" }
    });
    assert.doesNotMatch(JSON.stringify(envelope.operational), /migrate-1_1_0/);
  });
});

test("canonical projection refuses outside symlinks across every projected shelf", async (t) => {
  const cases = [
    ["identity", "context/identity.md", "# Identity\n\nOUTSIDE_CANARY\n"],
    ["priorities", "context/priorities.md", "# Priorities\n\nOUTSIDE_CANARY\n"],
    ["decisions", "decisions/log.md", "# Decisions\n\n## 2099-01-01\n\nOUTSIDE_CANARY\n"],
    ["daily-today", "memory/daily/2099-01-01.md", "# Daily\n\n## Focus\n\nOUTSIDE_CANARY\n"],
    ["daily-yesterday", "memory/daily/2098-12-31.md", "# Daily\n\n## Carry-over\n\nOUTSIDE_CANARY\n"],
    ["sessions", "memory/sessions/index.jsonl", '{"title":"OUTSIDE_CANARY"}\n'],
    ["events", "memory/events.jsonl", '{"ts":"2099-01-01T00:00:00Z","summary":"OUTSIDE_CANARY"}\n'],
    ["signals", "memory/signals/2099-01-01.jsonl", '{"summary":"OUTSIDE_CANARY"}\n'],
    ["project", "projects/demo/README.md", "---\nproject: demo\nstatus: active\n---\n# OUTSIDE_CANARY\n"]
  ];

  for (const [name, relativePath, content] of cases) {
    await t.test(name, async (subtest) => {
      const aiosPath = await makeAios(subtest, "1.2.0");
      const outside = path.join(path.dirname(aiosPath), `${name}-outside`);
      await fs.writeFile(outside, content);
      const target = path.join(aiosPath, relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(outside, target);

      await assert.rejects(
        buildSessionDigest(aiosPath, {}, { clock: () => new Date("2099-01-01T12:00:00Z") }),
        (error) => error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
          && !error.message.includes(aiosPath)
          && !error.message.includes("OUTSIDE_CANARY")
      );
    });
  }
});

test("a stable symlinked AIOS root keeps the resolved boundary usable", async (t) => {
  if (process.platform === "win32") return t.skip("symlink creation requires elevated Windows privileges");
  const aiosPath = await makeAios(t, "1.2.0");
  const aliasPath = path.join(path.dirname(aiosPath), "aios-alias");
  await fs.mkdir(path.join(aiosPath, "context"), { recursive: true });
  await fs.writeFile(path.join(aiosPath, "context", "identity.md"), "# Identity\n\nRESOLVED_ROOT_CANARY\n");
  await fs.symlink(aiosPath, aliasPath);

  const digest = await buildSessionDigest(aliasPath);

  assert.match(digest.digest, /RESOLVED_ROOT_CANARY/);
});

test("missing file and directory tails below a nested in-bound symlink are refused", async (t) => {
  if (process.platform === "win32") return t.skip("symlink creation requires elevated Windows privileges");
  const aiosPath = await makeAios(t, "1.2.0");
  const realDirectory = path.join(aiosPath, "memory", "real-empty");
  const linkedDirectory = path.join(aiosPath, "memory", "linked-empty");
  await fs.mkdir(realDirectory, { recursive: true });
  await fs.symlink(realDirectory, linkedDirectory);

  await assert.rejects(
    readContainedFile(aiosPath, path.join(linkedDirectory, "missing.txt"), {
      filesystem: fs,
      encoding: "utf8"
    }),
    (error) => error?.code === "DOTAIOS_UNSAFE_READ_PATH"
  );
  await assert.rejects(
    readContainedDirectory(aiosPath, path.join(linkedDirectory, "missing-directory"), {
      filesystem: fs,
      maxEntries: 1
    }),
    (error) => error?.code === "DOTAIOS_UNSAFE_READ_PATH"
  );
});

test("working-context projection requires one real configured AIOS authority", async (t) => {
  const missingPath = path.join(os.tmpdir(), `dotaios-missing-authority-${process.pid}-${Date.now()}`);
  await assert.rejects(
    buildSessionDigest(missingPath),
    (error) => error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
  );

  const sparseAios = await makeAios(t, "1.2.0");
  const sparse = await buildSessionDigest(sparseAios);
  assert.match(sparse.digest, /## Active Context/);
});

test("configured AIOS disappearance before or after optional reads fails closed", async (t) => {
  await t.test("before optional reads", async (subtest) => {
    const aiosPath = await makeAios(subtest, "1.2.0");
    const parkedPath = `${aiosPath}-parked`;
    const identityPath = path.join(aiosPath, "context", "identity.md");
    await fs.mkdir(path.dirname(identityPath), { recursive: true });
    await fs.writeFile(identityPath, "# Identity\n\nROOT_AUTHORITY_CANARY\n");
    let moved = false;
    const filesystem = proxyFilesystem({
      async lstat(candidate, options) {
        if (!moved && candidate === identityPath) {
          moved = true;
          await fs.rename(aiosPath, parkedPath);
        }
        return fs.lstat(candidate, options);
      }
    });

    await assert.rejects(
      buildSessionDigest(aiosPath, {}, { filesystem }),
      (error) => moved && error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
    );
    assert.match(await fs.readFile(path.join(parkedPath, "context", "identity.md"), "utf8"), /ROOT_AUTHORITY_CANARY/);
  });

  await t.test("after optional reads", async (subtest) => {
    const aiosPath = await makeAios(subtest, "1.2.0");
    const parkedPath = `${aiosPath}-parked`;
    const configPath = path.join(aiosPath, "aios.json");
    let configOpens = 0;
    const filesystem = proxyFilesystem({
      async open(candidate, flags) {
        if (candidate === configPath && ++configOpens === 2) {
          await fs.rename(aiosPath, parkedPath);
        }
        return fs.open(candidate, flags);
      }
    });

    await assert.rejects(
      buildSessionDigest(aiosPath, {}, { filesystem }),
      (error) => configOpens >= 2 && error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
    );
    assert.match(await fs.readFile(path.join(parkedPath, "aios.json"), "utf8"), /1\.2\.0/);
  });
});

test("an ancestor swap cannot hide signal directory entries", async (t) => {
  const aiosPath = await makeAios(t, "1.2.0");
  const memoryRoot = path.join(aiosPath, "memory");
  const parkedRoot = path.join(aiosPath, "memory-parked");
  const signalsPath = path.join(memoryRoot, "signals");
  const outsideMemory = path.join(path.dirname(aiosPath), "outside-empty-memory");
  const signalPath = path.join(signalsPath, "2099-01-01.jsonl");
  await fs.mkdir(signalsPath, { recursive: true });
  await fs.mkdir(path.join(outsideMemory, "signals"), { recursive: true });
  await fs.writeFile(
    signalPath,
    `${JSON.stringify({ ts: "2099-01-01T10:00:00Z", summary: "INSIDE_SIGNAL" })}\n`
  );
  let swaps = 0;
  let swapStarted = false;
  let completeSwap;
  const swapCompleted = new Promise((resolve) => { completeSwap = resolve; });
  const filesystem = proxyFilesystem({
    async opendir(candidate) {
      if (candidate !== signalsPath) return fs.opendir(candidate);
      swapStarted = true;
      try {
        await fs.rename(memoryRoot, parkedRoot);
        await fs.symlink(outsideMemory, memoryRoot);
        const directory = await fs.opendir(signalsPath);
        await fs.rm(memoryRoot);
        await fs.rename(parkedRoot, memoryRoot);
        swaps += 1;
        return directory;
      } finally {
        completeSwap();
      }
    }
  });

  await assert.rejects(
    buildSessionDigest(aiosPath, {}, {
      clock: () => new Date("2099-01-01T12:00:00Z"),
      filesystem
    }),
    (error) => swapStarted && error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
  );
  if (swapStarted && swaps === 0) await swapCompleted;
  assert.equal(swaps, 1);
  assert.equal(await fs.readFile(signalPath, "utf8"), '{"ts":"2099-01-01T10:00:00Z","summary":"INSIDE_SIGNAL"}\n');
});

test("a nested optional-shelf ancestor swap cannot masquerade as a missing daily note", async (t) => {
  if (process.platform === "win32") return t.skip("symlink creation requires elevated Windows privileges");
  const aiosPath = await makeAios(t, "1.2.0");
  const dailyDir = path.join(aiosPath, "memory", "daily");
  const parkedDir = path.join(aiosPath, "memory", "daily-parked");
  const outsideDir = path.join(path.dirname(aiosPath), "outside-empty-daily");
  const dailyPath = path.join(dailyDir, "2099-01-01.md");
  await fs.mkdir(dailyDir, { recursive: true });
  await fs.mkdir(outsideDir);
  await fs.writeFile(dailyPath, "# 2099-01-01\n\nINSIDE_DAILY_CANARY\n");
  let swapped = false;
  const filesystem = proxyFilesystem({
    async lstat(candidate, options) {
      if (!swapped && candidate === dailyPath) {
        swapped = true;
        await fs.rename(dailyDir, parkedDir);
        await fs.symlink(outsideDir, dailyDir);
      }
      return fs.lstat(candidate, options);
    }
  });

  await assert.rejects(
    buildSessionDigest(aiosPath, {}, {
      clock: () => new Date("2099-01-01T12:00:00Z"),
      filesystem
    }),
    (error) => swapped && error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
  );
  assert.match(await fs.readFile(path.join(parkedDir, "2099-01-01.md"), "utf8"), /INSIDE_DAILY_CANARY/);
});

test("an enumerated signal that disappears before its first file snapshot fails closed", async (t) => {
  const aiosPath = await makeAios(t, "1.2.0");
  const signalsPath = path.join(aiosPath, "memory", "signals");
  const signalPath = path.join(signalsPath, "2099-01-01.jsonl");
  await fs.mkdir(signalsPath, { recursive: true });
  await fs.writeFile(
    signalPath,
    `${JSON.stringify({ ts: "2099-01-01T10:00:00Z", summary: "MUST_NOT_DISAPPEAR" })}\n`
  );
  let signalLstats = 0;
  const filesystem = proxyFilesystem({
    async lstat(candidate, options) {
      if (candidate === signalPath && ++signalLstats === 1) {
        const error = new Error("simulated selected-file disappearance");
        error.code = "ENOENT";
        throw error;
      }
      return fs.lstat(candidate, options);
    }
  });

  await assert.rejects(
    buildSessionDigest(aiosPath, {}, {
      clock: () => new Date("2099-01-01T12:00:00Z"),
      filesystem
    }),
    (error) => signalLstats >= 1 && error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
  );
  assert.match(await fs.readFile(signalPath, "utf8"), /MUST_NOT_DISAPPEAR/);
});

test("a configured-root swap cannot hide project directory entries", async (t) => {
  const aiosPath = await makeAios(t, "1.2.0");
  const parkedRoot = `${aiosPath}-parked`;
  const projectsPath = path.join(aiosPath, "projects");
  const readmePath = path.join(projectsPath, "demo", "README.md");
  const outsideAios = path.join(path.dirname(aiosPath), "outside-empty-aios");
  await fs.mkdir(path.dirname(readmePath), { recursive: true });
  await fs.mkdir(path.join(outsideAios, "projects"), { recursive: true });
  await fs.writeFile(readmePath, "---\nproject: demo\n---\n# INSIDE_PROJECT\n");
  let swaps = 0;
  let swapStarted = false;
  let completeSwap;
  const swapCompleted = new Promise((resolve) => { completeSwap = resolve; });
  const filesystem = proxyFilesystem({
    async opendir(candidate) {
      if (candidate !== projectsPath) return fs.opendir(candidate);
      swapStarted = true;
      try {
        await fs.rename(aiosPath, parkedRoot);
        await fs.symlink(outsideAios, aiosPath);
        const directory = await fs.opendir(projectsPath);
        await fs.rm(aiosPath);
        await fs.rename(parkedRoot, aiosPath);
        swaps += 1;
        return directory;
      } finally {
        completeSwap();
      }
    }
  });

  await assert.rejects(
    buildSessionDigest(aiosPath, {}, { filesystem }),
    (error) => swapStarted && error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
  );
  if (swapStarted && swaps === 0) await swapCompleted;
  assert.equal(swaps, 1);
  assert.equal(await fs.readFile(readmePath, "utf8"), "---\nproject: demo\n---\n# INSIDE_PROJECT\n");
});

test("canonical projection rejects special-file sources without reading them", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX FIFO probe");
  const cases = [
    ["identity", "context/identity.md"],
    ["priorities", "context/priorities.md"],
    ["decisions", "decisions/log.md"],
    ["daily-today", "memory/daily/2099-01-01.md"],
    ["daily-yesterday", "memory/daily/2098-12-31.md"],
    ["sessions", "memory/sessions/index.jsonl"],
    ["events", "memory/events.jsonl"],
    ["signals", "memory/signals/2099-01-01.jsonl"],
    ["project", "projects/demo/README.md"]
  ];

  for (const [name, relativePath] of cases) {
    await t.test(name, async (subtest) => {
      const aiosPath = await makeAios(subtest, "1.2.0");
      const target = path.join(aiosPath, relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const result = spawnSync("mkfifo", [target]);
      assert.equal(result.status, 0, result.stderr?.toString() || "mkfifo failed");

      await assert.rejects(
        buildSessionDigest(aiosPath, {}, { clock: () => new Date("2099-01-01T12:00:00Z") }),
        (error) => error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
          && !error.message.includes(aiosPath)
      );
    });
  }
});

test("project README swap after catalog lstat cannot inject an outside file", async (t) => {
  const aiosPath = await makeAios(t, "1.2.0");
  const projectDir = path.join(aiosPath, "projects", "demo");
  const readmePath = path.join(projectDir, "README.md");
  const outsidePath = path.join(path.dirname(aiosPath), "outside-project.md");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(readmePath, "---\nproject: demo\nstatus: active\n---\n# Safe\n");
  await fs.writeFile(outsidePath, "---\nproject: demo\nstatus: active\n---\n# OUTSIDE_CANARY\n");

  let swapped = false;
  const racingFilesystem = new Proxy(fs, {
    get(target, property) {
      if (property === "open") {
        return async (candidate, flags) => {
          if (!swapped && candidate === readmePath) {
            swapped = true;
            await fs.rm(readmePath);
            await fs.symlink(outsidePath, readmePath);
          }
          return fs.open(candidate, flags);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  await assert.rejects(
    buildSessionDigest(aiosPath, {}, { filesystem: racingFilesystem }),
    (error) => swapped
      && error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
      && !error.message.includes(aiosPath)
      && !error.message.includes("OUTSIDE_CANARY")
  );
});

test("an enumerated project README that disappears before its first file snapshot fails closed", async (t) => {
  const aiosPath = await makeAios(t, "1.2.0");
  const projectDir = path.join(aiosPath, "projects", "demo");
  const readmePath = path.join(projectDir, "README.md");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    readmePath,
    "---\nid: stable:demo/01\nproject: demo\n---\n# Demo\n"
  );
  let readmeLstats = 0;
  const filesystem = proxyFilesystem({
    async lstat(candidate, options) {
      if (candidate === readmePath && ++readmeLstats === 1) {
        const error = new Error("simulated selected-README disappearance");
        error.code = "ENOENT";
        throw error;
      }
      return fs.lstat(candidate, options);
    }
  });

  await assert.rejects(
    buildSessionDigest(aiosPath, { project: "stable:demo/01" }, { filesystem }),
    (error) => readmeLstats >= 1 && error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
  );
  assert.match(await fs.readFile(readmePath, "utf8"), /stable:demo\/01/);
});

test("an initially absent project README remains an optional catalog entry", async (t) => {
  const aiosPath = await makeAios(t, "1.2.0");
  await fs.mkdir(path.join(aiosPath, "projects", "staging"), { recursive: true });

  const digest = await buildSessionDigest(aiosPath);

  assert.match(digest.digest, /## Active Context/);
  assert.doesNotMatch(digest.digest, /staging/);
});

test("a listed project directory swap cannot disguise its README as initially absent", async (t) => {
  if (process.platform === "win32") return t.skip("symlink creation requires elevated Windows privileges");
  const aiosPath = await makeAios(t, "1.2.0");
  const projectDir = path.join(aiosPath, "projects", "demo");
  const parkedDir = path.join(aiosPath, "projects", "demo-parked");
  const outsideDir = path.join(path.dirname(aiosPath), "outside-empty-project");
  const readmePath = path.join(projectDir, "README.md");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(outsideDir);
  await fs.writeFile(readmePath, "---\nproject: demo\n---\n# INSIDE_PROJECT_CANARY\n");
  let swapped = false;
  const filesystem = proxyFilesystem({
    async lstat(candidate, options) {
      if (!swapped && candidate === readmePath) {
        swapped = true;
        await fs.rename(projectDir, parkedDir);
        await fs.symlink(outsideDir, projectDir);
      }
      return fs.lstat(candidate, options);
    }
  });

  await assert.rejects(
    buildSessionDigest(aiosPath, {}, { filesystem }),
    (error) => swapped && error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
  );
  assert.match(await fs.readFile(path.join(parkedDir, "README.md"), "utf8"), /INSIDE_PROJECT_CANARY/);
});

test("a source that disappears after its snapshot fails closed", async (t) => {
  const aiosPath = await makeAios(t, "1.2.0");
  const identityPath = path.join(aiosPath, "context", "identity.md");
  const parkedPath = path.join(aiosPath, "context", "identity.parked.md");
  await fs.mkdir(path.dirname(identityPath), { recursive: true });
  await fs.writeFile(identityPath, "# Identity\n\nMust never disappear silently.\n");
  let raced = false;
  const racingFilesystem = proxyFilesystem({
    async open(candidate, flags) {
      if (candidate !== identityPath || raced) return fs.open(candidate, flags);
      raced = true;
      await fs.rename(identityPath, parkedPath);
      try {
        return await fs.open(candidate, flags);
      } finally {
        await fs.rename(parkedPath, identityPath);
      }
    }
  });

  await assert.rejects(
    buildSessionDigest(aiosPath, {}, { filesystem: racingFilesystem }),
    (error) => raced && error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
  );
  assert.equal(await fs.readFile(identityPath, "utf8"), "# Identity\n\nMust never disappear silently.\n");
});

test("an atomic regular-file replacement after the snapshot fails closed", async (t) => {
  const aiosPath = await makeAios(t, "1.2.0");
  const identityPath = path.join(aiosPath, "context", "identity.md");
  const parkedPath = path.join(aiosPath, "context", "identity.parked.md");
  const original = "# Identity\n\nINSIDE_CANARY\n";
  await fs.mkdir(path.dirname(identityPath), { recursive: true });
  await fs.writeFile(identityPath, original);
  let raced = false;
  const racingFilesystem = proxyFilesystem({
    async open(candidate, flags) {
      if (candidate !== identityPath || raced) return fs.open(candidate, flags);
      raced = true;
      await fs.rename(identityPath, parkedPath);
      await fs.writeFile(identityPath, "# Identity\n\nOUTSIDE_CANARY\n");
      return fs.open(identityPath, flags);
    }
  });

  try {
    await assert.rejects(
      buildSessionDigest(aiosPath, {}, { filesystem: racingFilesystem }),
      (error) => raced
        && error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
        && !error.message.includes("OUTSIDE_CANARY")
    );
  } finally {
    await fs.rm(identityPath, { force: true });
    await fs.rename(parkedPath, identityPath);
  }
  assert.equal(await fs.readFile(identityPath, "utf8"), original);
});

test("an in-place source rewrite restored before completion is still rejected", async (t) => {
  const aiosPath = await makeAios(t, "1.2.0");
  const identityPath = path.join(aiosPath, "context", "identity.md");
  const original = Buffer.from("# Identity\n\nINSIDE_CANARY_\n");
  const injected = Buffer.from("# Identity\n\nOUTSIDE_CANARY\n");
  assert.equal(injected.length, original.length, "the race must preserve file size");
  await fs.mkdir(path.dirname(identityPath), { recursive: true });
  await fs.writeFile(identityPath, original);
  const fixedTime = new Date("2020-01-01T00:00:00.000Z");
  await fs.utimes(identityPath, fixedTime, fixedTime);
  const originalStats = await fs.stat(identityPath);
  let raced = false;

  const racingFilesystem = proxyFilesystem({
    async open(candidate, flags) {
      const handle = await fs.open(candidate, flags);
      if (candidate !== identityPath) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "read") {
            return async (buffer, offset, length, position) => {
              raced = true;
              await fs.writeFile(identityPath, injected);
              const result = await target.read(buffer, offset, length, position);
              await fs.writeFile(identityPath, original);
              await fs.utimes(identityPath, originalStats.atime, originalStats.mtime);
              return result;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    }
  });

  await assert.rejects(
    buildSessionDigest(aiosPath, {}, { filesystem: racingFilesystem }),
    (error) => raced
      && error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
      && !error.message.includes("OUTSIDE_CANARY")
  );
  assert.deepEqual(await fs.readFile(identityPath), original);
});

test("a project directory symlink fails closed instead of disappearing from the catalog", async (t) => {
  const aiosPath = await makeAios(t, "1.2.0");
  const outsideProject = path.join(path.dirname(aiosPath), "outside-project-dir");
  await fs.mkdir(outsideProject);
  await fs.writeFile(path.join(outsideProject, "README.md"), "# OUTSIDE_CANARY\n");
  await fs.mkdir(path.join(aiosPath, "projects"));
  await fs.symlink(outsideProject, path.join(aiosPath, "projects", "demo"));

  await assert.rejects(
    buildSessionDigest(aiosPath),
    (error) => error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
      && !error.message.includes(aiosPath)
      && !error.message.includes("OUTSIDE_CANARY")
  );
});

test("invalid UTF-8 is never normalized into projected text", async (t) => {
  const cases = [
    ["identity", "context/identity.md"],
    ["priorities", "context/priorities.md"],
    ["decisions", "decisions/log.md"],
    ["daily-today", "memory/daily/2099-01-01.md"],
    ["daily-yesterday", "memory/daily/2098-12-31.md"],
    ["sessions", "memory/sessions/index.jsonl"],
    ["events", "memory/events.jsonl"],
    ["signals", "memory/signals/2099-01-01.jsonl"],
    ["project", "projects/demo/README.md"]
  ];
  for (const [name, relativePath] of cases) {
    await t.test(name, async (subtest) => {
      const aiosPath = await makeAios(subtest, "1.2.0");
      const target = path.join(aiosPath, relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const bytes = Buffer.concat([Buffer.from("INVALID_UTF8_"), Buffer.from([0xff]), Buffer.from("\n")]);
      await fs.writeFile(target, bytes);

      await assert.rejects(
        buildSessionDigest(aiosPath, {}, { clock: () => new Date("2099-01-01T12:00:00Z") }),
        (error) => error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
      );
      assert.deepEqual(await fs.readFile(target), bytes);
    });
  }
});

test("migration config and transaction swap races cannot spoof operational state", async (t) => {
  await t.test("config swap", async (subtest) => {
    const aiosPath = await makeAios(subtest, "1.2.0");
    const configPath = path.join(aiosPath, "aios.json");
    const outsidePath = path.join(path.dirname(aiosPath), "outside-config.json");
    await fs.writeFile(outsidePath, '{"schema_version":"1.1.0"}\n');
    let swapped = false;
    const racingFilesystem = proxyFilesystem({
      async open(candidate, flags) {
        if (!swapped && candidate === configPath) {
          swapped = true;
          await fs.rm(configPath);
          await fs.symlink(outsidePath, configPath);
        }
        return fs.open(candidate, flags);
      }
    });

    await assert.rejects(inspectMigrationState({ aiosPath }, { filesystem: racingFilesystem }));
    assert.equal(swapped, true);
  });

  await t.test("transaction directory swap", async (subtest) => {
    const aiosPath = await makeAios(subtest, "1.2.0");
    const migrationsRoot = path.join(aiosPath, ".dotaios", "migrations");
    const transactionsRoot = path.join(migrationsRoot, "transactions");
    const parkedRoot = path.join(migrationsRoot, "transactions-parked");
    const outsideRoot = path.join(path.dirname(aiosPath), "outside-transactions");
    const planId = "migrate-1_1_0-to-1_2_0-0123456789abcdef";
    await fs.mkdir(transactionsRoot, { recursive: true });
    await fs.writeFile(path.join(migrationsRoot, "owner.json"), `${JSON.stringify({ schema: "dotaios.migrations.v1" }, null, 2)}\n`);
    await fs.mkdir(path.join(outsideRoot, planId), { recursive: true });
    let swaps = 0;
    const racingFilesystem = proxyFilesystem({
      async opendir(candidate) {
        if (candidate !== transactionsRoot) return fs.opendir(candidate);
        await fs.rename(transactionsRoot, parkedRoot);
        await fs.symlink(outsideRoot, transactionsRoot);
        const directory = await fs.opendir(transactionsRoot);
        await fs.rm(transactionsRoot);
        await fs.rename(parkedRoot, transactionsRoot);
        swaps += 1;
        return directory;
      }
    });

    await assert.rejects(
      inspectMigrationState({ aiosPath }, { filesystem: racingFilesystem }),
      (error) => error?.code === "STATE_CHANGED"
    );
    assert.equal(swaps, 1);
    assert.deepEqual(await fs.readdir(transactionsRoot), []);
  });

  await t.test("an empty swapped directory cannot hide a real transaction", async (subtest) => {
    const aiosPath = await makeAios(subtest, "1.2.0");
    const migrationsRoot = path.join(aiosPath, ".dotaios", "migrations");
    const transactionsRoot = path.join(migrationsRoot, "transactions");
    const parkedRoot = path.join(migrationsRoot, "transactions-parked");
    const outsideRoot = path.join(path.dirname(aiosPath), "outside-empty-transactions");
    const planId = "migrate-1_1_0-to-1_2_0-0123456789abcdef";
    await makeInterruptedTransaction(aiosPath, planId);
    await fs.mkdir(outsideRoot);
    let swaps = 0;
    const racingFilesystem = proxyFilesystem({
      async opendir(candidate) {
        if (candidate !== transactionsRoot) return fs.opendir(candidate);
        await fs.rename(transactionsRoot, parkedRoot);
        await fs.symlink(outsideRoot, transactionsRoot);
        const directory = await fs.opendir(transactionsRoot);
        await fs.rm(transactionsRoot);
        await fs.rename(parkedRoot, transactionsRoot);
        swaps += 1;
        return directory;
      }
    });

    await assert.rejects(
      inspectMigrationState({ aiosPath }, { filesystem: racingFilesystem }),
      (error) => error?.code === "STATE_CHANGED"
    );
    assert.ok(swaps >= 1);
    assert.deepEqual(await fs.readdir(transactionsRoot), [planId]);
  });

  await t.test("an ancestor swap cannot hide a real transaction", async (subtest) => {
    const aiosPath = await makeAios(subtest, "1.2.0");
    const dotaiosRoot = path.join(aiosPath, ".dotaios");
    const transactionsRoot = path.join(dotaiosRoot, "migrations", "transactions");
    const parkedRoot = path.join(aiosPath, ".dotaios-parked");
    const outsideRoot = path.join(path.dirname(aiosPath), "outside-empty-dotaios");
    const planId = "migrate-1_1_0-to-1_2_0-0123456789abcdef";
    await makeInterruptedTransaction(aiosPath, planId);
    await fs.mkdir(path.join(outsideRoot, "migrations", "transactions"), { recursive: true });
    await fs.writeFile(
      path.join(outsideRoot, "migrations", "owner.json"),
      `${JSON.stringify({ schema: "dotaios.migrations.v1" }, null, 2)}\n`
    );
    let swaps = 0;
    const racingFilesystem = proxyFilesystem({
      async opendir(candidate) {
        if (candidate !== transactionsRoot) return fs.opendir(candidate);
        await fs.rename(dotaiosRoot, parkedRoot);
        await fs.symlink(outsideRoot, dotaiosRoot);
        const directory = await fs.opendir(transactionsRoot);
        await fs.rm(dotaiosRoot);
        await fs.rename(parkedRoot, dotaiosRoot);
        swaps += 1;
        return directory;
      }
    });

    await assert.rejects(
      inspectMigrationState({ aiosPath }, { filesystem: racingFilesystem }),
      (error) => error?.code === "STATE_CHANGED"
    );
    assert.ok(swaps >= 1);
    assert.deepEqual(await fs.readdir(transactionsRoot), [planId]);
  });

  await t.test("a repeatedly missing transaction directory cannot hide an owned transaction", async (subtest) => {
    const aiosPath = await makeAios(subtest, "1.2.0");
    const transactionsRoot = path.join(aiosPath, ".dotaios", "migrations", "transactions");
    const planId = "migrate-1_1_0-to-1_2_0-0123456789abcdef";
    await makeInterruptedTransaction(aiosPath, planId);
    let transactionLstats = 0;
    const filesystem = proxyFilesystem({
      async lstat(candidate, options) {
        if (candidate === transactionsRoot) {
          transactionLstats += 1;
          if (transactionLstats === 2 || transactionLstats === 4) {
            const error = new Error("simulated transaction-directory disappearance");
            error.code = "ENOENT";
            throw error;
          }
        }
        return fs.lstat(candidate, options);
      }
    });

    await assert.rejects(
      inspectMigrationState({ aiosPath }, { filesystem }),
      (error) => transactionLstats >= 2 && error?.code === "STATE_CHANGED"
    );
    assert.deepEqual(await fs.readdir(transactionsRoot), [planId]);
  });

  await t.test("an initial migration-metadata ancestor swap cannot hide an owned transaction", async (subtest) => {
    if (process.platform === "win32") return subtest.skip("symlink creation requires elevated Windows privileges");
    const aiosPath = await makeAios(subtest, "1.2.0");
    const dotaiosRoot = path.join(aiosPath, ".dotaios");
    const migrationsRoot = path.join(dotaiosRoot, "migrations");
    const parkedRoot = path.join(aiosPath, ".dotaios-parked-initial");
    const outsideRoot = path.join(path.dirname(aiosPath), "outside-empty-dotaios-initial");
    const planId = "migrate-1_1_0-to-1_2_0-0123456789abcdef";
    await makeInterruptedTransaction(aiosPath, planId);
    await fs.mkdir(outsideRoot);
    let swapped = false;
    const filesystem = proxyFilesystem({
      async lstat(candidate, options) {
        if (!swapped && candidate === migrationsRoot) {
          swapped = true;
          await fs.rename(dotaiosRoot, parkedRoot);
          await fs.symlink(outsideRoot, dotaiosRoot);
        }
        return fs.lstat(candidate, options);
      }
    });

    await assert.rejects(
      inspectMigrationState({ aiosPath }, { filesystem }),
      (error) => swapped && ["STATE_CHANGED", "UNSAFE_METADATA"].includes(error?.code)
    );
    assert.deepEqual(
      await fs.readdir(path.join(parkedRoot, "migrations", "transactions")),
      [planId]
    );
  });

  await t.test("an in-bound metadata symlink cannot hide an owned transaction", async (subtest) => {
    if (process.platform === "win32") return subtest.skip("symlink creation requires elevated Windows privileges");
    const aiosPath = await makeAios(subtest, "1.2.0");
    const dotaiosRoot = path.join(aiosPath, ".dotaios");
    const parkedRoot = path.join(aiosPath, ".dotaios-real");
    const emptyRoot = path.join(aiosPath, ".dotaios-empty");
    const planId = "migrate-1_1_0-to-1_2_0-0123456789abcdef";
    await makeInterruptedTransaction(aiosPath, planId);
    await fs.rename(dotaiosRoot, parkedRoot);
    await fs.mkdir(emptyRoot);
    await fs.symlink(emptyRoot, dotaiosRoot);

    await assert.rejects(
      inspectMigrationState({ aiosPath }),
      (error) => error?.code === "UNSAFE_METADATA"
    );
    assert.deepEqual(
      await fs.readdir(path.join(parkedRoot, "migrations", "transactions")),
      [planId]
    );
  });
});

async function makeAios(t, schemaVersion) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-envelope-"));
  const aiosPath = path.join(root, "aios");
  await fs.mkdir(aiosPath);
  await fs.writeFile(path.join(aiosPath, "aios.json"), `${JSON.stringify({ schema_version: schemaVersion })}\n`);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return aiosPath;
}

async function makeInterruptedTransaction(aiosPath, planId) {
  const root = path.join(aiosPath, ".dotaios", "migrations");
  await fs.mkdir(path.join(root, "transactions", planId), { recursive: true });
  await fs.writeFile(path.join(root, "owner.json"), `${JSON.stringify({ schema: "dotaios.migrations.v1" }, null, 2)}\n`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function proxyFilesystem(overrides) {
  return new Proxy(fs, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function recordingFilesystemFor(calls) {
  return new Proxy(fs, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args) => {
        calls.push([String(property), ...args.filter((argument) => typeof argument === "string")]);
        return value.apply(target, args);
      };
    }
  });
}

function configBytes(size) {
  const prefix = Buffer.from('{"schema_version":"1.2.0","padding":"');
  const suffix = Buffer.from('"}\n');
  assert.ok(size >= prefix.length + suffix.length);
  return Buffer.concat([
    prefix,
    Buffer.alloc(size - prefix.length - suffix.length, 0x61),
    suffix
  ]);
}
