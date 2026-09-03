import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyManagedScheduleFile,
  applyManagedScheduleRepair,
  planManagedScheduleRepair,
  previewManagedScheduleFile
} from "../../packages/cli/src/commands/schedule.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");
const candidateVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
const candidateInvocation = `npx dotaios@${candidateVersion}`;
const candidateParts = candidateVersion.split(".").map(Number);
const futureVersion = [...candidateParts.slice(0, 2), candidateParts[2] + 1].join(".");

for (const origin of ["2.0.9", "2.0.10", "2.0.11", "2.0.12", "2.0.18"]) {
  test(`repairs only generated ${origin} schedule command scalars`, () => {
    const predecessor = `npx dotaios@${origin}`;
    const source = [
      `# keep this historical example: ${predecessor} is text, not a field`,
      "schedules:",
      "  # generated defaults with user annotations",
      "  - name: daily-brief",
      "    cadence: daily",
      `    command: \"${predecessor} brief\" # keep inline`,
      "    enabled: false",
      "    custom_flag: keep-me",
      "  - name: weekly-health-check",
      "    cadence: weekly",
      `    command: "${predecessor} doctor"`,
      "    enabled: false",
      "  - name: weekly-memory-audit",
      "    cadence: weekly",
      `    command: \"${predecessor} memory audit --all-memory\"`,
      "    enabled: false",
      "  - name: personal-job",
      "    command: \"node custom.js\"",
      "    owner: user",
      "tail: preserve",
      ""
    ].join("\r\n");

    const expected = source
      .replace(`\"${predecessor} brief\"`, `\"${candidateInvocation} brief\"`)
      .replace(`"${predecessor} doctor"`, `"${candidateInvocation} doctor"`)
      .replace(
        `\"${predecessor} memory audit --all-memory\"`,
        `\"${candidateInvocation} memory audit --all-memory\"`
      );
    const plan = planManagedScheduleRepair(source, { candidateVersion });

    assert.equal(plan.status, "ready");
    assert.equal("origin_version" in plan, false);
    assert.equal(plan.changes.length, 3);
    assert.deepEqual(plan.conflicts, []);
    assert.equal(applyManagedScheduleRepair(source, plan), expected);
    assert.match(expected, new RegExp(`^# keep this historical example: ${predecessor.replaceAll(".", "\\.")}`, "m"));
  });
}

for (const unsupported of ["2.0.8", futureVersion, `${candidateVersion}-beta.1`, `0${candidateVersion}`]) {
  test(`refuses unsupported generated-looking ${unsupported} schedule commands`, () => {
    const source = [
      "schedules:",
      "  - name: daily-brief",
      `    command: "npx dotaios@${unsupported} brief"`,
      "    enabled: false",
      ""
    ].join("\n");

    const plan = planManagedScheduleRepair(source, { candidateVersion });

    assert.equal(plan.status, "blocked-conflict");
    assert.deepEqual(plan.changes, []);
    assert.match(JSON.stringify(plan.conflicts), /custom-official-command/);
    assert.throws(() => applyManagedScheduleRepair(source, plan), /conflict/i);
  });
}

test("apply refuses caller-supplied changes outside the previewed command fields", () => {
  const source = [
    "schedules:",
    "  - name: daily-brief",
    "    command: \"npx dotaios@2.0.10 brief\"",
    "    enabled: false",
    ""
  ].join("\n");
  const plan = planManagedScheduleRepair(source, { candidateVersion });
  const enabledStart = source.indexOf("false");
  const forged = {
    ...plan,
    changes: [
      ...plan.changes,
      {
        name: "daily-brief",
        field: "enabled",
        from: "false",
        to: "true",
        start: enabledStart,
        end: enabledStart + "false".length,
        expected: "false",
        replacement: "true"
      }
    ]
  };

  assert.throws(
    () => applyManagedScheduleRepair(source, forged),
    /fingerprint|preview plan|invalid/i
  );
  assert.match(source, /enabled: false/);
});

test("accepts a generated bare predecessor but refuses custom or ambiguous official fields", () => {
  const bareSource = [
    "schedules:",
    "  - name: daily-brief",
    "    command: \"dotaios brief\"",
    "    enabled: false",
    ""
  ].join("\n");
  const barePlan = planManagedScheduleRepair(bareSource, { candidateVersion });
  assert.equal(barePlan.status, "ready");
  assert.equal(
    applyManagedScheduleRepair(bareSource, barePlan),
    bareSource.replace("\"dotaios brief\"", `\"${candidateInvocation} brief\"`)
  );

  for (const source of [
    [
      "schedules:",
      "  - name: daily-brief",
      "    command: \"npx dotaios@2.0.10 brief --custom\"",
      "  - name: personal-job",
      "    command: \"node custom.js\"",
      ""
    ].join("\n"),
    [
      "schedules:",
      "  - name: daily-brief",
      "    command: \"dotaios brief\"",
      "  - name: daily-brief",
      "    command: \"dotaios brief\"",
      ""
    ].join("\n"),
    [
      "schedules:",
      "  - name: daily-brief",
      "    command: 'dotaios brief'",
      ""
    ].join("\n")
  ]) {
    const plan = planManagedScheduleRepair(source, { candidateVersion });
    assert.equal(plan.status, "blocked-conflict");
    assert.ok(plan.conflicts.length > 0);
    assert.throws(() => applyManagedScheduleRepair(source, plan), /conflict/i);
    assert.equal(source.includes("personal-job") ? source.includes("node custom.js") : true, true);
  }
});

test("classifies every generated command from its own bytes without a folder origin", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-schedule-byte-origin-"));
  const aiosPath = path.join(root, "aios");
  const schedulesPath = path.join(aiosPath, "schedules.yml");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = [
    "schedules:",
    "  - name: daily-brief",
    "    command: \"dotaios brief\"",
    "    enabled: false",
    "  - name: weekly-health-check",
    "    command: \"npx dotaios@2.0.8 doctor\"",
    "    enabled: false",
    ""
  ].join("\n");
  const plan = planManagedScheduleRepair(source, { candidateVersion });

  assert.equal(plan.status, "blocked-conflict");
  assert.equal(plan.changes.length, 1);
  assert.deepEqual(plan.changes.map(({ name }) => name), ["daily-brief"]);
  assert.match(JSON.stringify(plan.conflicts), /weekly-health-check|custom-official-command|2\.0\.9\/2\.0\.10\/2\.0\.11/i);
  assert.doesNotMatch(JSON.stringify(plan.conflicts), /unsupported-origin/i);
  assert.throws(() => applyManagedScheduleRepair(source, plan), /conflict/i);
  assert.match(source, /npx dotaios@2\.0\.8 doctor/);

  fs.mkdirSync(aiosPath, { recursive: true });
  fs.writeFileSync(schedulesPath, source);
  const preview = await previewManagedScheduleFile(schedulesPath, {
    boundaryRoot: aiosPath,
    candidateVersion
  });
  const result = await applyManagedScheduleFile(schedulesPath, {
    boundaryRoot: aiosPath,
    candidateVersion,
    expectedFingerprint: preview.fingerprint
  });
  assert.equal(result.status, "blocked-conflict");
  assert.equal(fs.readFileSync(schedulesPath, "utf8"), source);
});

test("the schedule domain owner binds preview identity and publishes through the guarded writer", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-schedule-file-owner-"));
  const aiosPath = path.join(root, "aios");
  const schedulesPath = path.join(aiosPath, "schedules.yml");
  const source = [
    "# preserve this header",
    "schedules:",
    "  - name: daily-brief",
    "    command: \"npx dotaios@2.0.10 brief\" # preserve this comment",
    "    enabled: false",
    ""
  ].join("\n");
  fs.mkdirSync(aiosPath, { recursive: true });
  fs.writeFileSync(schedulesPath, source);
  const originalMode = fs.statSync(schedulesPath).mode & 0o777;
  const options = {
    boundaryRoot: aiosPath,
    candidateVersion
  };

  try {
    const modePreview = await previewManagedScheduleFile(schedulesPath, options);
    assert.equal(modePreview.target.path, schedulesPath);
    assert.equal(modePreview.status, "ready");
    fs.chmodSync(schedulesPath, originalMode === 0o600 ? 0o644 : 0o600);
    const modeConflict = await applyManagedScheduleFile(schedulesPath, {
      ...options,
      expectedFingerprint: modePreview.fingerprint
    });
    assert.equal(modeConflict.action, "conflict");
    assert.equal(fs.readFileSync(schedulesPath, "utf8"), source);

    fs.chmodSync(schedulesPath, originalMode);
    fs.writeFileSync(schedulesPath, source);
    const concurrentPreview = await previewManagedScheduleFile(schedulesPath, options);
    const concurrentSource = source.replace("# preserve this header", "# concurrent user edit");
    const concurrentConflict = await applyManagedScheduleFile(schedulesPath, {
      ...options,
      expectedFingerprint: concurrentPreview.fingerprint,
      beforeReplace: () => fs.writeFileSync(schedulesPath, concurrentSource)
    });
    assert.equal(concurrentConflict.action, "conflict");
    assert.equal(fs.readFileSync(schedulesPath, "utf8"), concurrentSource);

    fs.writeFileSync(schedulesPath, source, { mode: originalMode });
    const preview = await previewManagedScheduleFile(schedulesPath, options);
    const result = await applyManagedScheduleFile(schedulesPath, {
      ...options,
      expectedFingerprint: preview.fingerprint
    });
    assert.equal(result.action, "updated");
    assert.equal(result.status, "verified");
    assert.equal(
      fs.readFileSync(schedulesPath, "utf8"),
      source.replace("npx dotaios@2.0.10 brief", `${candidateInvocation} brief`)
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the schedule domain owner refuses verified status when the postimage disappears", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-schedule-postimage-"));
  const aiosPath = path.join(root, "aios");
  const schedulesPath = path.join(aiosPath, "schedules.yml");
  const source = [
    "schedules:",
    "  - name: daily-brief",
    "    command: \"npx dotaios@2.0.10 brief\"",
    ""
  ].join("\n");
  fs.mkdirSync(aiosPath, { recursive: true });
  fs.writeFileSync(schedulesPath, source);
  const preview = await previewManagedScheduleFile(schedulesPath, {
    boundaryRoot: aiosPath,
    candidateVersion
  });
  try {
    const result = await applyManagedScheduleFile(schedulesPath, {
      boundaryRoot: aiosPath,
      candidateVersion,
      expectedFingerprint: preview.fingerprint,
      beforeVerify: () => fs.rmSync(schedulesPath)
    });
    assert.equal(result.status, "recovery-required");
    assert.equal(fs.existsSync(schedulesPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the schedule domain owner refuses verified status for a semantically current byte drift", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-schedule-byte-drift-"));
  const aiosPath = path.join(root, "aios");
  const schedulesPath = path.join(aiosPath, "schedules.yml");
  const source = [
    "schedules:",
    "  - name: daily-brief",
    "    command: \"npx dotaios@2.0.10 brief\"",
    ""
  ].join("\n");
  fs.mkdirSync(aiosPath, { recursive: true });
  fs.writeFileSync(schedulesPath, source);
  const preview = await previewManagedScheduleFile(schedulesPath, {
    boundaryRoot: aiosPath,
    candidateVersion
  });
  try {
    const result = await applyManagedScheduleFile(schedulesPath, {
      boundaryRoot: aiosPath,
      candidateVersion,
      expectedFingerprint: preview.fingerprint,
      beforeVerify: () => fs.appendFileSync(schedulesPath, "# concurrent comment\n")
    });
    assert.equal(result.status, "recovery-required");
    assert.match(fs.readFileSync(schedulesPath, "utf8"), /concurrent comment/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the schedule domain owner refuses a symlinked postimage with identical bytes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-schedule-postimage-symlink-"));
  const aiosPath = path.join(root, "aios");
  const schedulesPath = path.join(aiosPath, "schedules.yml");
  const backingPath = path.join(root, "published.yml");
  const source = [
    "schedules:",
    "  - name: daily-brief",
    "    command: \"npx dotaios@2.0.10 brief\"",
    ""
  ].join("\n");
  fs.mkdirSync(aiosPath, { recursive: true });
  fs.writeFileSync(schedulesPath, source);
  const preview = await previewManagedScheduleFile(schedulesPath, {
    boundaryRoot: aiosPath,
    candidateVersion
  });
  try {
    const result = await applyManagedScheduleFile(schedulesPath, {
      boundaryRoot: aiosPath,
      candidateVersion,
      expectedFingerprint: preview.fingerprint,
      beforeVerify: ({ next }) => {
        fs.writeFileSync(backingPath, next);
        fs.rmSync(schedulesPath);
        fs.symlinkSync(backingPath, schedulesPath);
      }
    });
    assert.equal(result.status, "recovery-required");
    assert.equal(fs.lstatSync(schedulesPath).isSymbolicLink(), true);
    assert.match(fs.readFileSync(backingPath, "utf8"), new RegExp(candidateInvocation));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the schedule domain owner refuses a symlinked schedule file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-schedule-file-symlink-"));
  const aiosPath = path.join(root, "aios");
  const outsidePath = path.join(root, "outside.yml");
  const schedulesPath = path.join(aiosPath, "schedules.yml");
  fs.mkdirSync(aiosPath, { recursive: true });
  fs.writeFileSync(outsidePath, "schedules: []\n");
  fs.symlinkSync(outsidePath, schedulesPath);

  try {
    await assert.rejects(
      previewManagedScheduleFile(schedulesPath, {
        boundaryRoot: aiosPath,
        candidateVersion
      }),
      /unsafe|symlink|cannot overwrite/i
    );
    assert.equal(fs.readFileSync(outsidePath, "utf8"), "schedules: []\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runs a generated npx schedule through the in-package CLI without executing npx", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-schedule-npx-"));
  const aiosPath = path.join(root, "aios");
  const fakeBin = path.join(root, "bin");
  const executionMarker = path.join(root, "npx-executed");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "npx"),
    `#!/bin/sh\nprintf executed > ${executionMarker}\nexit 99\n`,
    { mode: 0o755 }
  );

  try {
    const init = spawnSync(process.execPath, [cli, "init", "--yes", "--path", aiosPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: fakeBin }
    });
    assert.equal(init.status, 0, init.stderr);

    const schedulesPath = path.join(aiosPath, "schedules.yml");
    const before = [
      "# preserve this header",
      "schedules:",
      "  - name: local-status",
      "    cadence: weekly",
      "    command: \"npx dotaios@2.0.10 status\" # generated invocation",
      "    enabled: true",
      "    custom_flag: keep-me",
      "tail: preserve",
      ""
    ].join("\n");
    fs.writeFileSync(schedulesPath, before);

    const run = spawnSync(
      process.execPath,
      [cli, "schedule", "run", "local-status", "--path", aiosPath],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, PATH: fakeBin }
      }
    );
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /Running in-package DotAIOS: status --path /);
    assert.doesNotMatch(run.stdout, /Running:\s+dotaios\b/);
    assert.equal(fs.existsSync(executionMarker), false, "the PATH-resolved npx binary was executed");

    const after = fs.readFileSync(schedulesPath, "utf8");
    assert.match(after, /^    last_run: /m);
    assert.equal(after.replace(/^    last_run: .*\n/m, ""), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("run-due records every due schedule without changing the remaining file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-schedule-run-due-"));
  const aiosPath = path.join(root, "aios");

  try {
    const init = spawnSync(process.execPath, [cli, "init", "--yes", "--path", aiosPath], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    assert.equal(init.status, 0, init.stderr);

    const schedulesPath = path.join(aiosPath, "schedules.yml");
    const before = [
      "# preserve this header",
      "schedules:",
      "  - name: first-status",
      "    cadence: weekly",
      "    command: \"npx dotaios@2.0.10 status\" # generated invocation",
      "    enabled: true",
      "    custom_flag: keep-first",
      "  # preserve this separator",
      "  - name: second-status",
      "    cadence: daily",
      "    command: \"npx dotaios@2.0.10 status\"",
      "    enabled: true",
      "    custom_flag: keep-second",
      "tail: preserve",
      ""
    ].join("\n");
    fs.writeFileSync(schedulesPath, before);

    const run = spawnSync(
      process.execPath,
      [cli, "schedule", "run-due", "--path", aiosPath],
      { cwd: repoRoot, encoding: "utf8" }
    );
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

    const after = fs.readFileSync(schedulesPath, "utf8");
    const entries = after.split(/^  - /m).slice(1);
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      const timestamp = entry.match(
        /^name: (?:first|second)-status[\s\S]*^    last_run: "([^"]+)"$/m
      )?.[1];
      assert.ok(timestamp);
      assert.equal(new Date(timestamp).toISOString(), timestamp);
    }
    assert.equal(after.match(/^    last_run: /gm)?.length, 2);
    assert.equal(after.replace(/^    last_run: .*\n/gm, ""), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a flow-style schedule even on dry-run when last_run has no safe field boundary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-schedule-flow-"));
  const aiosPath = path.join(root, "aios");
  try {
    const init = spawnSync(process.execPath, [cli, "init", "--yes", "--path", aiosPath], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    assert.equal(init.status, 0, init.stderr);

    const schedulesPath = path.join(aiosPath, "schedules.yml");
    const source = "schedules:\n  - { name: local-status, command: \"npx dotaios@2.0.10 status\", enabled: true }\n";
    fs.writeFileSync(schedulesPath, source);
    const run = spawnSync(
      process.execPath,
      [cli, "schedule", "run", "local-status", "--dry-run", "--path", aiosPath],
      { cwd: repoRoot, encoding: "utf8" }
    );

    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /flow-style|last_run|field boundary/i);
    assert.doesNotMatch(run.stdout, /DotAIOS status for/);
    assert.equal(fs.readFileSync(schedulesPath, "utf8"), source);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("strict YAML and duplicate schedule names fail closed before a dry-run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-schedule-ambiguous-"));
  const aiosPath = path.join(root, "aios");
  try {
    const init = spawnSync(process.execPath, [cli, "init", "--yes", "--path", aiosPath], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    assert.equal(init.status, 0, init.stderr);

    const schedulesPath = path.join(aiosPath, "schedules.yml");
    const cases = [
      {
        name: "duplicate schedule names",
        source: [
          "schedules:",
          "  - name: local-status",
          "    command: \"npx dotaios@2.0.10 status\"",
          "    enabled: true",
          "  - name: local-status",
          "    command: \"npx dotaios@2.0.10 status\"",
          "    enabled: true",
          ""
        ].join("\n"),
        error: /ambiguous schedule/i,
      },
      {
        name: "duplicate YAML keys",
        source: [
          "schedules:",
          "  - name: local-status",
          "    name: shadow-status",
          "    command: \"npx dotaios@2.0.10 status\"",
          "    enabled: true",
          ""
        ].join("\n"),
        error: /map keys must be unique|duplicate/i,
      },
    ];

    for (const fixture of cases) {
      fs.writeFileSync(schedulesPath, fixture.source);
      const run = spawnSync(
        process.execPath,
        [cli, "schedule", "run", "local-status", "--dry-run", "--path", aiosPath],
        { cwd: repoRoot, encoding: "utf8" }
      );
      assert.notEqual(run.status, 0, fixture.name);
      assert.match(run.stderr, fixture.error, fixture.name);
      assert.doesNotMatch(run.stdout, /Would run in-package DotAIOS/, fixture.name);
      assert.equal(fs.readFileSync(schedulesPath, "utf8"), fixture.source, fixture.name);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("decoded terminal controls fail closed before schedule output or dry-run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-schedule-controls-"));
  const aiosPath = path.join(root, "aios");
  try {
    const init = spawnSync(process.execPath, [cli, "init", "--yes", "--path", aiosPath], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    assert.equal(init.status, 0, init.stderr);

    const schedulesPath = path.join(aiosPath, "schedules.yml");
    const fixtures = [
      {
        field: "name",
        source: "schedules:\n  - name: \"unsafe\\x1bname\"\n    cadence: daily\n    command: \"npx dotaios@2.0.10 status\"\n    enabled: true\n",
        args: ["schedule", "list", "--path", aiosPath]
      },
      {
        field: "cadence",
        source: "schedules:\n  - name: local-status\n    cadence: \"daily\\u202E\"\n    command: \"npx dotaios@2.0.10 status\"\n    enabled: true\n",
        args: ["schedule", "due", "--path", aiosPath]
      },
      {
        field: "command",
        source: "schedules:\n  - name: local-status\n    cadence: daily\n    command: \"npx dotaios@2.0.10 status\\x07\"\n    enabled: true\n",
        args: ["schedule", "run", "local-status", "--dry-run", "--path", aiosPath]
      }
    ];

    for (const fixture of fixtures) {
      fs.writeFileSync(schedulesPath, fixture.source);
      const result = spawnSync(process.execPath, [cli, ...fixture.args], {
        cwd: repoRoot,
        encoding: "utf8"
      });
      assert.notEqual(result.status, 0, fixture.field);
      assert.match(result.stderr, new RegExp(`schedule ${fixture.field}.*control`, "i"), fixture.field);
      assert.equal(result.stdout, "", fixture.field);
      assert.equal(fs.readFileSync(schedulesPath, "utf8"), fixture.source, fixture.field);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keeps a quoted false schedule disabled", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-schedule-disabled-"));
  const aiosPath = path.join(root, "aios");
  try {
    const init = spawnSync(process.execPath, [cli, "init", "--yes", "--path", aiosPath], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    assert.equal(init.status, 0, init.stderr);

    const schedulesPath = path.join(aiosPath, "schedules.yml");
    const source = [
      "schedules:",
      "  - name: local-status",
      "    command: \"npx dotaios@2.0.10 status\"",
      "    enabled: \"false\"",
      ""
    ].join("\n");
    fs.writeFileSync(schedulesPath, source);
    const run = spawnSync(
      process.execPath,
      [cli, "schedule", "run", "local-status", "--path", aiosPath],
      { cwd: repoRoot, encoding: "utf8" }
    );

    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /schedule is disabled/i);
    assert.doesNotMatch(run.stdout, /DotAIOS status for/);
    assert.equal(fs.readFileSync(schedulesPath, "utf8"), source);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("treats empty and comment-only schedule registries as no schedules", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-schedule-empty-"));
  const aiosPath = path.join(root, "aios");
  try {
    const init = spawnSync(process.execPath, [cli, "init", "--yes", "--path", aiosPath], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    assert.equal(init.status, 0, init.stderr);

    const schedulesPath = path.join(aiosPath, "schedules.yml");
    for (const source of ["", "# schedules intentionally cleared\n"]) {
      fs.writeFileSync(schedulesPath, source);
      const list = spawnSync(
        process.execPath,
        [cli, "schedule", "list", "--path", aiosPath],
        { cwd: repoRoot, encoding: "utf8" }
      );

      assert.equal(list.status, 0, list.stderr);
      assert.match(list.stdout, /No schedules configured\./);
      assert.equal(fs.readFileSync(schedulesPath, "utf8"), source);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
