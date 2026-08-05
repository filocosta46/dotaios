import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyMigration,
  previewMigration,
  recoverMigration
} from "../../packages/core/src/migrations.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixtureRoot = path.join(repoRoot, "tests", "fixtures", "migrations", "schema-1.0.0");

test("preview is deterministic and writes zero files", async (t) => {
  const aiosPath = await copyHistoricalFixture(t);
  const before = await snapshotTree(aiosPath);

  const first = await previewMigration({ aiosPath });
  const second = await previewMigration({ aiosPath });

  assert.equal(first.status, "ready");
  assert.deepEqual(second, first);
  assert.match(first.plan.plan_id, /^migrate-1_0_0-to-1_2_0-[a-f0-9]{16}$/);
  assert.equal(first.plan.from_schema_version, "1.0.0");
  assert.equal(first.plan.to_schema_version, "1.2.0");
  assert.deepEqual(first.plan.operations.map((operation) => operation.path), [".gitignore", "aios.json"]);
  assert.deepEqual(
    first.plan.operations.map(({ path: operationPath, ownership }) => ({ path: operationPath, ownership })),
    [
      { path: ".gitignore", ownership: "DotAIOS sync safety metadata" },
      { path: "aios.json", ownership: "DotAIOS compatibility metadata" }
    ]
  );
  assert.ok(first.plan.preserved_paths.some((entry) => entry.path === "context/identity.md"));
  assert.equal("created_at" in first.plan, false);
  assert.equal("release_version" in first.plan, false);
  assert.deepEqual(await snapshotTree(aiosPath), before);
});

test("apply changes only compatibility metadata and preserves user and edited scaffold bytes", async (t) => {
  const aiosPath = await copyHistoricalFixture(t);
  const beforeConfig = await fs.readFile(path.join(aiosPath, "aios.json"));
  const protectedBefore = await snapshotTree(aiosPath, keepUserAndScaffold);
  const preview = await previewMigration({ aiosPath });

  const result = await applyMigration({
    aiosPath,
    planId: preview.plan.plan_id,
    releaseVersion: "1.23.0"
  });

  assert.equal(result.status, "applied");
  const expectedConfig = Buffer.from(beforeConfig.toString("utf8").replace('"1.0.0"', '"1.2.0"'));
  assert.deepEqual(await fs.readFile(path.join(aiosPath, "aios.json")), expectedConfig);
  assert.equal(await fs.readFile(path.join(aiosPath, ".gitignore"), "utf8"), "/workspaces/\n");
  assert.deepEqual(await snapshotTree(aiosPath, keepUserAndScaffold), protectedBefore);

  const receipt = JSON.parse(await fs.readFile(path.join(aiosPath, result.receipt_path), "utf8"));
  assert.equal(receipt.plan_id, preview.plan.plan_id);
  assert.equal(receipt.release_version, "1.23.0");
  assert.equal(receipt.from_schema_version, "1.0.0");
  assert.equal(receipt.to_schema_version, "1.2.0");
  assert.deepEqual(receipt.operations.map((operation) => operation.path), [".gitignore", "aios.json"]);
  assert.ok(receipt.preserved_paths.some((entry) => entry.path === "projects/atlas/README.md"));
  assert.equal(receipt.recovery.strategy, "journaled-backup");
  assert.match(receipt.recovery.rollback_command, /migrate --recover/);
  assert.equal(
    receipt.recovery.backups.find((backup) => backup.path === "aios.json").backup_path,
    ".dotaios/migrations/transactions/" + preview.plan.plan_id + "/backups/aios.json"
  );
});

test("the 1.1 workspace migration preserves custom ignore bytes and appends one anchored rule", async (t) => {
  const aiosPath = await copyHistoricalFixture(t);
  const configPath = path.join(aiosPath, "aios.json");
  const ignorePath = path.join(aiosPath, ".gitignore");
  const config = await fs.readFile(configPath, "utf8");
  await fs.writeFile(configPath, config.replace('"1.0.0"', '"1.1.0"'));
  await fs.writeFile(ignorePath, "# personal rules\n.env\n");
  if (process.platform !== "win32") {
    await fs.chmod(configPath, 0o640);
    await fs.chmod(ignorePath, 0o660);
  }

  const preview = await previewMigration({ aiosPath });
  assert.equal(preview.plan.from_schema_version, "1.1.0");
  assert.equal(preview.plan.to_schema_version, "1.2.0");
  assert.deepEqual(preview.plan.operations.map((operation) => operation.path), [".gitignore", "aios.json"]);

  await applyMigration({
    aiosPath,
    planId: preview.plan.plan_id,
    releaseVersion: "1.28.0"
  });

  assert.equal(
    await fs.readFile(ignorePath, "utf8"),
    "# personal rules\n.env\n/workspaces/\n"
  );
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(ignorePath)).mode & 0o777, 0o660);
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o640);
  }
  assert.equal(JSON.parse(await fs.readFile(configPath, "utf8")).schema_version, "1.2.0");
});

test("an existing exact workspace ignore is not duplicated or rewritten", async (t) => {
  const aiosPath = await copyHistoricalFixture(t);
  const configPath = path.join(aiosPath, "aios.json");
  await fs.writeFile(configPath, (await fs.readFile(configPath, "utf8")).replace('"1.0.0"', '"1.1.0"'));
  const originalIgnore = Buffer.from("/workspaces/\n# keep this byte-for-byte\n");
  await fs.writeFile(path.join(aiosPath, ".gitignore"), originalIgnore);

  const preview = await previewMigration({ aiosPath });
  assert.deepEqual(preview.plan.operations.map((operation) => operation.path), ["aios.json"]);
  await applyMigration({ aiosPath, planId: preview.plan.plan_id, releaseVersion: "1.28.0" });
  assert.deepEqual(await fs.readFile(path.join(aiosPath, ".gitignore")), originalIgnore);
});

test("workspace migration repairs a later rule that cancels the boundary", async (t) => {
  const aiosPath = await copyHistoricalFixture(t);
  const configPath = path.join(aiosPath, "aios.json");
  const ignorePath = path.join(aiosPath, ".gitignore");
  await fs.writeFile(configPath, (await fs.readFile(configPath, "utf8")).replace('"1.0.0"', '"1.1.0"'));
  await fs.writeFile(ignorePath, "/workspaces/\n!/workspaces/\n");

  const preview = await previewMigration({ aiosPath });
  assert.deepEqual(preview.plan.operations.map((operation) => operation.path), [".gitignore", "aios.json"]);
  await applyMigration({ aiosPath, planId: preview.plan.plan_id, releaseVersion: "1.28.0" });
  assert.equal(await fs.readFile(ignorePath, "utf8"), "/workspaces/\n!/workspaces/\n/workspaces/\n");
});

test("workspace migration refuses a symlinked .gitignore without touching its target", async (t) => {
  const aiosPath = await copyHistoricalFixture(t);
  const configPath = path.join(aiosPath, "aios.json");
  await fs.writeFile(configPath, (await fs.readFile(configPath, "utf8")).replace('"1.0.0"', '"1.1.0"'));
  const outside = path.join(path.dirname(aiosPath), "outside-ignore");
  await fs.writeFile(outside, "outside\n");
  await fs.symlink(outside, path.join(aiosPath, ".gitignore"));

  await assert.rejects(
    previewMigration({ aiosPath }),
    (error) => error.code === "UNSAFE_FILE" && /\.gitignore must be a regular file/.test(error.message)
  );
  assert.equal(await fs.readFile(outside, "utf8"), "outside\n");
});

test("an existing receipt makes apply byte-for-byte idempotent", async (t) => {
  const aiosPath = await copyHistoricalFixture(t);
  const preview = await previewMigration({ aiosPath });
  await applyMigration({ aiosPath, planId: preview.plan.plan_id, releaseVersion: "1.23.0" });
  const afterFirstApply = await snapshotTree(aiosPath);

  const second = await applyMigration({
    aiosPath,
    planId: preview.plan.plan_id,
    releaseVersion: "9.9.9"
  });

  assert.equal(second.status, "already_applied");
  assert.deepEqual(await snapshotTree(aiosPath), afterFirstApply);
});

test("apply rejects a config edit made after preview before writing transaction metadata", async (t) => {
  const aiosPath = await copyHistoricalFixture(t);
  const preview = await previewMigration({ aiosPath });
  const configPath = path.join(aiosPath, "aios.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.local_preference = "edited-after-preview";
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const edited = await snapshotTree(aiosPath);

  await assert.rejects(
    applyMigration({ aiosPath, planId: preview.plan.plan_id, releaseVersion: "1.23.0" }),
    (error) => error.code === "PLAN_CHANGED"
  );
  assert.deepEqual(await snapshotTree(aiosPath), edited);
  assert.equal(fsSync.existsSync(path.join(aiosPath, ".dotaios")), false);
});

test("apply accepts the previewed plan after preserved memory grows", async (t) => {
  const aiosPath = await copyHistoricalFixture(t);
  const preview = await previewMigration({ aiosPath });
  await fs.appendFile(
    path.join(aiosPath, "memory", "events.jsonl"),
    `${JSON.stringify({ ts: "2026-07-16T00:00:00.000Z", type: "update", source: "dotaios update", summary: "post-preview note" })}\n`
  );

  const result = await applyMigration({
    aiosPath,
    planId: preview.plan.plan_id,
    releaseVersion: "1.23.0"
  });

  assert.equal(result.status, "applied");
  const receipt = JSON.parse(await fs.readFile(path.join(aiosPath, result.receipt_path), "utf8"));
  assert.equal(receipt.plan_id, preview.plan.plan_id);
  assert.ok(receipt.preserved_paths.some((entry) => entry.path === "memory/events.jsonl"));
});

test("apply refuses a permission change made after staging", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX mode semantics");
  const aiosPath = await copyHistoricalFixture(t);
  const configPath = path.join(aiosPath, "aios.json");
  await fs.chmod(configPath, 0o644);
  const preview = await previewMigration({ aiosPath });
  let checks = 0;
  const signal = {
    get aborted() {
      checks += 1;
      if (checks === 3) {
        fsSync.chmodSync(configPath, 0o600);
      }
      return false;
    }
  };

  await assert.rejects(
    applyMigration({
      aiosPath,
      planId: preview.plan.plan_id,
      releaseVersion: "1.28.0",
      signal
    }),
    (error) => error.code === "CONCURRENT_EDIT" && error.details.path === "aios.json"
  );
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
});

test("interrupted apply leaves a journal and backup that recovery can roll back", async (t) => {
  const aiosPath = await copyHistoricalFixture(t);
  const originalConfig = await fs.readFile(path.join(aiosPath, "aios.json"));
  const protectedBefore = await snapshotTree(aiosPath, keepUserAndScaffold);
  const preview = await previewMigration({ aiosPath });
  const transactionRoot = path.join(
    aiosPath,
    ".dotaios",
    "migrations",
    "transactions",
    preview.plan.plan_id
  );
  const signal = {
    get aborted() {
      return fsSync.existsSync(path.join(transactionRoot, "journal.json"));
    }
  };

  await assert.rejects(
    applyMigration({
      aiosPath,
      planId: preview.plan.plan_id,
      releaseVersion: "1.23.0",
      signal
    }),
    (error) => error.code === "APPLY_INTERRUPTED"
  );

  assert.deepEqual(
    await fs.readFile(path.join(transactionRoot, "backups", "aios.json")),
    originalConfig
  );
  const journalPath = path.join(transactionRoot, "journal.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
  assert.equal(journal.status, "prepared");

  // Model a journal written by the previous release, then a process ending
  // after the config commit but before its receipt. Adding mode metadata must
  // not strand a migration that was already interrupted in the field.
  for (const operation of journal.operations) {
    delete operation.before_mode;
    delete operation.after_mode;
  }
  journal.status = "committing";
  await fs.writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  await fs.rename(
    path.join(transactionRoot, "staged", "aios.json"),
    path.join(aiosPath, "aios.json")
  );
  if (process.platform !== "win32") {
    await fs.chmod(path.join(aiosPath, "aios.json"), 0o600);
  }
  assert.equal(JSON.parse(await fs.readFile(path.join(aiosPath, "aios.json"), "utf8")).schema_version, "1.2.0");

  const blocked = await previewMigration({ aiosPath });
  assert.equal(blocked.status, "recovery_required");
  const recovered = await recoverMigration({ aiosPath, planId: preview.plan.plan_id });
  assert.equal(recovered.status, "rolled_back");
  assert.equal(recovered.schema_version, "1.0.0");
  assert.deepEqual(await fs.readFile(path.join(aiosPath, "aios.json")), originalConfig);
  if (process.platform !== "win32") {
    assert.equal(
      (await fs.stat(path.join(aiosPath, "aios.json"))).mode & 0o777,
      0o600,
      "legacy journals remain hash-only and preserve the current mode while restoring bytes"
    );
  }
  assert.deepEqual(await snapshotTree(aiosPath, keepUserAndScaffold), protectedBefore);
  assert.equal(fsSync.existsSync(transactionRoot), false);
  assert.equal((await previewMigration({ aiosPath })).plan.plan_id, preview.plan.plan_id);
});

test("recovery restores .gitignore when interruption happens before schema commit", async (t) => {
  const aiosPath = await copyHistoricalFixture(t);
  const configPath = path.join(aiosPath, "aios.json");
  const ignorePath = path.join(aiosPath, ".gitignore");
  await fs.writeFile(configPath, (await fs.readFile(configPath, "utf8")).replace('"1.0.0"', '"1.1.0"'));
  await fs.writeFile(ignorePath, "# custom\n.env\n");
  if (process.platform !== "win32") {
    await fs.chmod(configPath, 0o640);
    await fs.chmod(ignorePath, 0o660);
  }
  const originalConfig = await fs.readFile(configPath);
  const originalIgnore = await fs.readFile(ignorePath);
  const preview = await previewMigration({ aiosPath });
  const transactionRoot = path.join(aiosPath, ".dotaios", "migrations", "transactions", preview.plan.plan_id);
  const signal = {
    get aborted() {
      return fsSync.existsSync(path.join(transactionRoot, "journal.json"));
    }
  };

  await assert.rejects(
    applyMigration({
      aiosPath,
      planId: preview.plan.plan_id,
      releaseVersion: "1.28.0",
      signal
    }),
    (error) => error.code === "APPLY_INTERRUPTED"
  );

  const journalPath = path.join(transactionRoot, "journal.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
  const ignoreOperation = journal.operations.find((operation) => operation.path === ".gitignore");
  if (process.platform !== "win32") {
    assert.equal(ignoreOperation.before_mode, 0o660);
    assert.equal(ignoreOperation.after_mode, 0o660);
  }
  journal.status = "applying";
  await fs.writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  await fs.rename(path.join(transactionRoot, "staged", ".gitignore"), ignorePath);
  assert.match(await fs.readFile(ignorePath, "utf8"), /\/workspaces\//);
  if (process.platform !== "win32") {
    assert.equal(
      (await fs.stat(ignorePath)).mode & 0o777,
      0o660,
      "the committed staged replacement retains the planned mode"
    );
  }
  assert.deepEqual(await fs.readFile(configPath), originalConfig);

  const recovered = await recoverMigration({ aiosPath, planId: preview.plan.plan_id });
  assert.equal(recovered.status, "rolled_back");
  assert.equal(recovered.schema_version, "1.1.0");
  assert.deepEqual(await fs.readFile(ignorePath), originalIgnore);
  assert.deepEqual(await fs.readFile(configPath), originalConfig);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(ignorePath)).mode & 0o777, 0o660);
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o640);
  }
  assert.equal(fsSync.existsSync(transactionRoot), false);
});

test("recovery refuses a permission edit made after a migration operation committed", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX mode semantics");
  const aiosPath = await copyHistoricalFixture(t);
  const configPath = path.join(aiosPath, "aios.json");
  const ignorePath = path.join(aiosPath, ".gitignore");
  await fs.writeFile(configPath, (await fs.readFile(configPath, "utf8")).replace('"1.0.0"', '"1.1.0"'));
  await fs.writeFile(ignorePath, "# custom\n.env\n");
  await fs.chmod(ignorePath, 0o660);

  const preview = await previewMigration({ aiosPath });
  const transactionRoot = path.join(aiosPath, ".dotaios", "migrations", "transactions", preview.plan.plan_id);
  const signal = {
    get aborted() {
      return fsSync.existsSync(path.join(transactionRoot, "journal.json"));
    }
  };
  await assert.rejects(
    applyMigration({
      aiosPath,
      planId: preview.plan.plan_id,
      releaseVersion: "1.28.0",
      signal
    }),
    (error) => error.code === "APPLY_INTERRUPTED"
  );

  const journalPath = path.join(transactionRoot, "journal.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
  journal.status = "applying";
  await fs.writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  await fs.rename(path.join(transactionRoot, "staged", ".gitignore"), ignorePath);
  await fs.chmod(ignorePath, 0o600);
  const migratedBytes = await fs.readFile(ignorePath);

  await assert.rejects(
    recoverMigration({ aiosPath, planId: preview.plan.plan_id }),
    (error) => error.code === "CONCURRENT_EDIT" && error.details.path === ".gitignore"
  );
  assert.deepEqual(await fs.readFile(ignorePath), migratedBytes);
  assert.equal((await fs.stat(ignorePath)).mode & 0o777, 0o600);
  assert.equal(fsSync.existsSync(transactionRoot), true, "failed recovery keeps its journal and backup");
});

test("recovery resumes an exact .gitignore staging residue left before replacement", async (t) => {
  const aiosPath = await copyHistoricalFixture(t);
  const configPath = path.join(aiosPath, "aios.json");
  const ignorePath = path.join(aiosPath, ".gitignore");
  await fs.writeFile(configPath, (await fs.readFile(configPath, "utf8")).replace('"1.0.0"', '"1.1.0"'));
  await fs.writeFile(ignorePath, "# custom\n.env\n");
  if (process.platform !== "win32") await fs.chmod(ignorePath, 0o660);
  const originalIgnore = await fs.readFile(ignorePath);
  const originalMode = (await fs.stat(ignorePath)).mode & 0o777;
  const preview = await previewMigration({ aiosPath });
  const transactionRoot = await prepareInterruptedTransaction(aiosPath, preview.plan.plan_id);

  await setTransactionStatus(transactionRoot, "applying");
  await fs.rename(path.join(transactionRoot, "staged", ".gitignore"), ignorePath);
  const recoveryPath = path.join(transactionRoot, "recovery", ".gitignore");
  await fs.mkdir(path.dirname(recoveryPath), { recursive: true });
  await fs.writeFile(recoveryPath, originalIgnore, { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") await fs.chmod(recoveryPath, 0o600);

  const recovered = await recoverMigration({ aiosPath, planId: preview.plan.plan_id });

  assert.equal(recovered.status, "rolled_back");
  assert.deepEqual(await fs.readFile(ignorePath), originalIgnore);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(ignorePath)).mode & 0o777, originalMode);
  }
  assert.equal(fsSync.existsSync(transactionRoot), false);
});

test("recovery resumes an exact aios.json staging residue and restores its journaled mode", async (t) => {
  const aiosPath = await copyHistoricalFixture(t);
  const configPath = path.join(aiosPath, "aios.json");
  if (process.platform !== "win32") await fs.chmod(configPath, 0o660);
  const originalConfig = await fs.readFile(configPath);
  const originalMode = (await fs.stat(configPath)).mode & 0o777;
  const preview = await previewMigration({ aiosPath });
  const transactionRoot = await prepareInterruptedTransaction(aiosPath, preview.plan.plan_id);

  await setTransactionStatus(transactionRoot, "applying");
  await fs.rename(
    path.join(transactionRoot, "staged", ".gitignore"),
    path.join(aiosPath, ".gitignore")
  );
  await setTransactionStatus(transactionRoot, "committing");
  await fs.rename(path.join(transactionRoot, "staged", "aios.json"), configPath);
  const recoveryPath = path.join(transactionRoot, "recovery", "aios.json");
  await fs.mkdir(path.dirname(recoveryPath), { recursive: true });
  await fs.writeFile(recoveryPath, originalConfig, { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") await fs.chmod(recoveryPath, 0o600);

  const recovered = await recoverMigration({ aiosPath, planId: preview.plan.plan_id });

  assert.equal(recovered.status, "rolled_back");
  assert.equal(recovered.schema_version, "1.0.0");
  assert.deepEqual(await fs.readFile(configPath), originalConfig);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(configPath)).mode & 0o777, originalMode);
  }
  assert.equal(fsSync.existsSync(path.join(aiosPath, ".gitignore")), false);
  assert.equal(fsSync.existsSync(transactionRoot), false);
});

test("recovery preserves a changed foreign staging residue and the migrated destination", async (t) => {
  const aiosPath = await copyHistoricalFixture(t);
  const configPath = path.join(aiosPath, "aios.json");
  const ignorePath = path.join(aiosPath, ".gitignore");
  await fs.writeFile(configPath, (await fs.readFile(configPath, "utf8")).replace('"1.0.0"', '"1.1.0"'));
  await fs.writeFile(ignorePath, "# original\n");
  const preview = await previewMigration({ aiosPath });
  const transactionRoot = await prepareInterruptedTransaction(aiosPath, preview.plan.plan_id);

  await setTransactionStatus(transactionRoot, "applying");
  await fs.rename(path.join(transactionRoot, "staged", ".gitignore"), ignorePath);
  const migratedIgnore = await fs.readFile(ignorePath);
  const recoveryPath = path.join(transactionRoot, "recovery", ".gitignore");
  await fs.mkdir(path.dirname(recoveryPath), { recursive: true });
  await fs.writeFile(recoveryPath, "foreign bytes\n", { flag: "wx", mode: 0o600 });
  const foreignMode = (await fs.stat(recoveryPath)).mode & 0o777;

  await assert.rejects(
    recoverMigration({ aiosPath, planId: preview.plan.plan_id }),
    (error) => error.code === "UNSAFE_RECOVERY_RESIDUE" && error.details.path === ".gitignore"
  );

  assert.deepEqual(await fs.readFile(ignorePath), migratedIgnore);
  assert.equal(await fs.readFile(recoveryPath, "utf8"), "foreign bytes\n");
  assert.equal((await fs.stat(recoveryPath)).mode & 0o777, foreignMode);
  assert.equal(fsSync.existsSync(transactionRoot), true);
});

test("recovery refuses an exact hard-linked residue without changing its external target", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX hard-link and mode semantics");
  const aiosPath = await copyHistoricalFixture(t);
  const configPath = path.join(aiosPath, "aios.json");
  const ignorePath = path.join(aiosPath, ".gitignore");
  await fs.writeFile(configPath, (await fs.readFile(configPath, "utf8")).replace('"1.0.0"', '"1.1.0"'));
  await fs.writeFile(ignorePath, "# original\n");
  await fs.chmod(ignorePath, 0o660);
  const originalIgnore = await fs.readFile(ignorePath);
  const preview = await previewMigration({ aiosPath });
  const transactionRoot = await prepareInterruptedTransaction(aiosPath, preview.plan.plan_id);

  await setTransactionStatus(transactionRoot, "applying");
  await fs.rename(path.join(transactionRoot, "staged", ".gitignore"), ignorePath);
  const migratedIgnore = await fs.readFile(ignorePath);
  const recoveryPath = path.join(transactionRoot, "recovery", ".gitignore");
  const externalPath = path.join(path.dirname(aiosPath), "external-recovery-target");
  await fs.mkdir(path.dirname(recoveryPath), { recursive: true });
  await fs.writeFile(externalPath, originalIgnore, { flag: "wx", mode: 0o600 });
  await fs.chmod(externalPath, 0o600);
  await fs.link(externalPath, recoveryPath);

  await assert.rejects(
    recoverMigration({ aiosPath, planId: preview.plan.plan_id }),
    (error) => error.code === "UNSAFE_RECOVERY_RESIDUE" && error.details.path === ".gitignore"
  );

  assert.deepEqual(await fs.readFile(ignorePath), migratedIgnore);
  assert.deepEqual(await fs.readFile(externalPath), originalIgnore);
  assert.equal((await fs.stat(externalPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(externalPath)).nlink, 2);
  assert.equal(fsSync.existsSync(transactionRoot), true);
});

test("future folder schemas are refused without writes", async (t) => {
  const aiosPath = await copyHistoricalFixture(t);
  const configPath = path.join(aiosPath, "aios.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.schema_version = "99.0.0";
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const before = await snapshotTree(aiosPath);

  await assert.rejects(
    previewMigration({ aiosPath }),
    (error) => error.code === "FUTURE_SCHEMA" && /Refusing to write/.test(error.message)
  );
  assert.deepEqual(await snapshotTree(aiosPath), before);
});

test("migration metadata refuses a symlinked .dotaios parent", async (t) => {
  const aiosPath = await copyHistoricalFixture(t);
  const externalMetadata = path.join(path.dirname(aiosPath), "external-dotaios");
  await fs.mkdir(externalMetadata, { recursive: true });
  await fs.rm(path.join(aiosPath, ".dotaios"), { recursive: true, force: true });
  await fs.symlink(externalMetadata, path.join(aiosPath, ".dotaios"), "dir");

  await assert.rejects(
    previewMigration({ aiosPath }),
    (error) => error.code === "UNSAFE_METADATA" && /\.dotaios must be a real directory/.test(error.message)
  );
  assert.equal((await fs.readdir(externalMetadata)).length, 0);
});

async function prepareInterruptedTransaction(aiosPath, planId) {
  const transactionRoot = path.join(
    aiosPath,
    ".dotaios",
    "migrations",
    "transactions",
    planId
  );
  const signal = {
    get aborted() {
      return fsSync.existsSync(path.join(transactionRoot, "journal.json"));
    }
  };
  await assert.rejects(
    applyMigration({ aiosPath, planId, releaseVersion: "crash-resume-test", signal }),
    (error) => error.code === "APPLY_INTERRUPTED"
  );
  return transactionRoot;
}

async function setTransactionStatus(transactionRoot, status) {
  const journalPath = path.join(transactionRoot, "journal.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
  journal.status = status;
  await fs.writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
}

async function copyHistoricalFixture(t) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-migration-"));
  const aiosPath = path.join(tempRoot, "aios");
  await fs.cp(fixtureRoot, aiosPath, { recursive: true });
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  return aiosPath;
}

function keepUserAndScaffold(relativePath) {
  return !["aios.json", ".gitignore"].includes(relativePath) && !relativePath.startsWith(".dotaios/");
}

async function snapshotTree(root, include = () => true) {
  const result = {};
  await visit(root, "");
  return result;

  async function visit(directory, prefix) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (include(relativePath)) {
        result[relativePath] = (await fs.readFile(absolutePath)).toString("base64");
      }
    }
  }
}
