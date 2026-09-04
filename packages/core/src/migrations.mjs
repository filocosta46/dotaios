import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ContainedReadError,
  inspectContainedDirectory,
  readContainedDirectory,
  readContainedFile
} from "./contained-read.mjs";
import { repeatedJsonObjectKey } from "./json.mjs";
import { schemaVersion } from "./schema.mjs";
import { endsWithManagedWorkspaceIgnoreRule } from "./workspace-ignore.mjs";

const PLAN_SCHEMA = "dotaios.migration-plan.v1";
const JOURNAL_SCHEMA = "dotaios.migration-journal.v1";
const RECEIPT_SCHEMA = "dotaios.migration-receipt.v1";
const OWNER_CONTENT = `${JSON.stringify({ schema: "dotaios.migrations.v1" }, null, 2)}\n`;
const PROTECTED_SHELVES = Object.freeze(["context/", "projects/", "memory/", "vault/"]);
const WRITABLE_PATHS = new Set([".gitignore", "aios.json"]);

// This registry is deliberately ordered and internal. Folder schema versions,
// not package releases, select the exact chain that runs.
const MIGRATIONS = Object.freeze([
  Object.freeze({
    id: "schema-1.0.0-to-1.1.0",
    from: "1.0.0",
    to: "1.1.0",
    summary: "Record support for preview-first, receipted folder migrations.",
    migrate(files) {
      const relativePath = "aios.json";
      const before = files.get(relativePath);
      const after = replaceSchemaVersion(before, this.from, this.to);
      return [{
        path: relativePath,
        after,
        ownership: "DotAIOS compatibility metadata",
        summary: "Update only schema_version; preserve every other config byte."
      }];
    }
  }),
  Object.freeze({
    id: "schema-1.1.0-to-1.2.0",
    from: "1.1.0",
    to: "1.2.0",
    summary: "Keep managed project workspaces outside the private AIOS mirror.",
    migrate(files) {
      const configPath = "aios.json";
      const configBefore = files.get(configPath);
      const ignorePath = ".gitignore";
      const ignoreBefore = files.get(ignorePath) || Buffer.alloc(0);
      return [
        {
          path: ignorePath,
          after: appendWorkspaceIgnore(ignoreBefore),
          ownership: "DotAIOS sync safety metadata",
          summary: "Append the anchored /workspaces/ rule while preserving existing ignore bytes."
        },
        {
          path: configPath,
          after: replaceSchemaVersion(configBefore, this.from, this.to),
          ownership: "DotAIOS compatibility metadata",
          summary: "Update only schema_version; preserve every other config byte."
        }
      ];
    }
  })
]);

validateRegistry();

export class MigrationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MigrationError";
    this.code = code;
    this.details = details;
  }
}

export async function previewMigration({ aiosPath }) {
  const root = requireAiosPath(aiosPath);
  const configState = await readConfigState(root);
  assertSupportedSchema(configState.version);

  const activeTransactions = await listActiveTransactions(root);
  if (activeTransactions.length > 0) {
    return {
      status: "recovery_required",
      schema_version: configState.version,
      current_schema_version: schemaVersion,
      transaction_ids: activeTransactions,
      protected_shelves: [...PROTECTED_SHELVES]
    };
  }

  const preview = await buildPreviewForRoot(root, configState);
  if (preview.status !== "ready") return publicPreview(preview);
  const preservedPaths = await inventoryPreservedPaths(root);
  return publicPreview({ ...preview, plan: { ...preview.plan, preserved_paths: preservedPaths } });
}

/**
 * Inspect only the compatibility metadata needed at session start.
 *
 * Unlike previewMigration, this deliberately does not build a plan or inventory
 * protected shelves. It reads aios.json plus owned transaction directory names
 * so every working-context adapter can surface action state without recursively
 * reading the user's memory.
 */
export async function inspectMigrationState({ aiosPath }, dependencies = {}) {
  return inspectMigrationStateWithPolicy({ aiosPath }, dependencies, { requireAiosIdentity: false });
}

/**
 * Authenticate the bounded portable config before a caller grants any memory
 * scope. Compatibility alone is insufficient here: JSON.parse can hide a
 * duplicate schema key, and a lookalike folder can copy only schema_version.
 */
export async function inspectAiosRootIdentity({ aiosPath }, dependencies = {}) {
  return inspectMigrationStateWithPolicy({ aiosPath }, dependencies, { requireAiosIdentity: true });
}

async function inspectMigrationStateWithPolicy(
  { aiosPath },
  dependencies,
  { requireAiosIdentity }
) {
  const root = requireAiosPath(aiosPath);
  const fileSystem = dependencies.filesystem || dependencies.fs || fs;
  const configState = await readConfigState(root, fileSystem, { maxBytes: 1024 * 1024 });
  assertSupportedSchema(configState.version);
  if (requireAiosIdentity) assertAiosIdentityConfig(configState);

  const activeTransactions = await inspectActiveTransactions(root, fileSystem);
  const confirmedConfig = await readConfigState(root, fileSystem, { maxBytes: 1024 * 1024 });
  if (requireAiosIdentity) assertAiosIdentityConfig(confirmedConfig);
  const confirmedTransactions = await inspectActiveTransactions(root, fileSystem);
  if (
    !configState.bytes.equals(confirmedConfig.bytes)
    || JSON.stringify(activeTransactions) !== JSON.stringify(confirmedTransactions)
  ) {
    throw new MigrationError("STATE_CHANGED", "Migration compatibility state changed during inspection.");
  }
  const withIdentity = (state) => requireAiosIdentity
    ? { ...state, config_identity: sha256(configState.bytes) }
    : state;
  if (activeTransactions.length > 0) {
    return withIdentity({
      status: "transaction_present",
      folder_schema_version: configState.version,
      supported_schema_version: schemaVersion
    });
  }

  if (configState.version === schemaVersion) {
    return withIdentity({
      status: "current",
      folder_schema_version: configState.version,
      supported_schema_version: schemaVersion
    });
  }

  return withIdentity({
    status: "schema_outdated",
    folder_schema_version: configState.version,
    supported_schema_version: schemaVersion
  });
}

function assertAiosIdentityConfig(configState) {
  const text = configState.bytes.toString("utf8");
  const repeatedKey = repeatedJsonObjectKey(text, { topLevelOnly: true });
  if (repeatedKey !== null) {
    throw new MigrationError(
      "INVALID_CONFIG_IDENTITY",
      `aios.json contains a duplicate top-level key (${JSON.stringify(repeatedKey)}).`
    );
  }

  const config = configState.config;
  const has = (key) => Object.prototype.hasOwnProperty.call(config, key);
  if (!["schema_version", "created_at", "ai_tools", "vault_path"].every(has)) {
    throw new MigrationError(
      "INVALID_CONFIG_IDENTITY",
      "aios.json is missing required DotAIOS identity fields."
    );
  }
  if (
    typeof config.created_at !== "string"
    || Number.isNaN(Date.parse(config.created_at))
    || new Date(config.created_at).toISOString() !== config.created_at
  ) {
    throw new MigrationError("INVALID_CONFIG_IDENTITY", "aios.json created_at must be a canonical ISO timestamp.");
  }
  if (!Array.isArray(config.ai_tools) || config.ai_tools.some((tool) => typeof tool !== "string")) {
    throw new MigrationError("INVALID_CONFIG_IDENTITY", "aios.json ai_tools must be an array of strings.");
  }
  if (config.vault_path !== null && typeof config.vault_path !== "string") {
    throw new MigrationError("INVALID_CONFIG_IDENTITY", "aios.json vault_path must be a string or null.");
  }
  if (has("skills_first") && typeof config.skills_first !== "boolean") {
    throw new MigrationError("INVALID_CONFIG_IDENTITY", "aios.json skills_first must be a boolean when present.");
  }
}

async function inspectActiveTransactions(root, fileSystem) {
  try {
    const migrationsRoot = migrationMetadataPath(root);
    const metadataStats = await inspectContainedDirectory(root, migrationsRoot, { filesystem: fileSystem });
    if (metadataStats === null) return [];

    const ownerPath = path.join(migrationsRoot, "owner.json");
    const owner = await readContainedFile(root, ownerPath, {
      encoding: "utf8",
      filesystem: fileSystem,
      maxBytes: 4096
    });
    if (owner === null) {
      const entries = await readContainedDirectory(root, migrationsRoot, {
        filesystem: fileSystem,
        maxEntries: 1
      });
      if (entries?.length === 0) return [];
      throw new MigrationError("UNOWNED_METADATA", "Migration metadata has no recognized ownership marker.");
    }
    if (owner !== OWNER_CONTENT) {
      throw new MigrationError("UNOWNED_METADATA", "Migration metadata has no recognized ownership marker.");
    }

    const transactionsRoot = path.join(migrationsRoot, "transactions");
    const entries = await readContainedDirectory(root, transactionsRoot, {
      filesystem: fileSystem,
      maxEntries: 16,
      readdirOptions: { withFileTypes: true },
      tooManyCode: "TOO_MANY_TRANSACTIONS"
    });
    if (entries === null) {
      throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
    }

    const ids = [];
    for (const entry of entries) {
      assertPlanId(entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new MigrationError("STATE_CHANGED", "Migration transaction metadata changed during inspection.");
      }
      ids.push(entry.name);
    }
    return ids.sort();
  } catch (error) {
    if (error instanceof ContainedReadError) {
      if (error.code === "TOO_MANY_TRANSACTIONS") {
        throw new MigrationError(
          "TOO_MANY_TRANSACTIONS",
          "Migration transaction metadata exceeds the inspection limit of 16."
        );
      }
      const code = error.code === "DOTAIOS_CONTEXT_SOURCE_CHANGED" ? "STATE_CHANGED" : "UNSAFE_METADATA";
      throw new MigrationError(code, "Migration metadata could not be inspected safely.");
    }
    throw error;
  }
}

export async function applyMigration({ aiosPath, planId, releaseVersion, signal = null }) {
  const root = requireAiosPath(aiosPath);
  assertPlanId(planId);
  if (typeof releaseVersion !== "string" || releaseVersion.trim() === "") {
    throw new MigrationError("INVALID_RELEASE_VERSION", "A non-empty package release version is required for the migration receipt.");
  }

  throwIfAborted(signal, false);
  const configState = await readConfigState(root);
  assertSupportedSchema(configState.version);
  await assertMetadataOwnedIfPresent(root);

  const existingReceipt = await readReceipt(root, planId);
  if (existingReceipt) {
    validateReceipt(existingReceipt, planId);
    if (compareVersions(configState.version, existingReceipt.to_schema_version) < 0) {
      throw new MigrationError(
        "RECEIPT_STATE_MISMATCH",
        `Receipt ${planId} exists, but aios.json reports older schema ${configState.version}. Run recovery before trying again.`
      );
    }
    return {
      status: "already_applied",
      plan_id: planId,
      schema_version: configState.version,
      receipt_path: receiptRelativePath(planId)
    };
  }

  const activeTransactions = await listActiveTransactions(root);
  if (activeTransactions.length > 0) {
    throw recoveryRequired(activeTransactions);
  }

  const identityCheck = await buildPreviewForRoot(root, configState);
  if (identityCheck.status === "current") {
    throw new MigrationError(
      "NO_MIGRATION_NEEDED",
      `Schema ${schemaVersion} is already current and there is no receipt for plan ${planId}.`
    );
  }
  if (identityCheck.plan.plan_id !== planId) {
    throw new MigrationError(
      "PLAN_CHANGED",
      `Plan ${planId} no longer matches the folder. Preview again; no migration files were changed.`,
      { expected_plan_id: identityCheck.plan.plan_id }
    );
  }
  const preservedPaths = await inventoryPreservedPaths(root);
  const computed = { ...identityCheck, plan: { ...identityCheck.plan, preserved_paths: preservedPaths } };

  throwIfAborted(signal, false);
  const metadata = await ensureOwnedMetadata(root);
  const transactionRoot = path.join(metadata.transactions, planId);
  try {
    await fs.mkdir(transactionRoot);
  } catch (error) {
    if (error.code === "EEXIST") throw recoveryRequired([planId]);
    throw error;
  }

  const journal = createJournal(computed.plan, computed.changes);
  await writeInitialJournal(transactionRoot, journal);
  await stageTransaction(root, transactionRoot, computed.changes, journal);
  throwIfAborted(signal, true, planId);
  await assertChangesUnchanged(root, computed.changes);

  const nonConfigChanges = computed.changes.filter((change) => change.path !== "aios.json");
  if (nonConfigChanges.length > 0) {
    await updateJournal(transactionRoot, { ...journal, status: "applying" });
    for (const change of nonConfigChanges) {
      throwIfAborted(signal, true, planId);
      await commitChange(root, transactionRoot, change);
    }
  }

  const configChange = computed.changes.find((change) => change.path === "aios.json");
  if (!configChange) {
    throw new MigrationError("INVALID_REGISTRY", "Every migration chain must commit aios.json last.");
  }

  await updateJournal(transactionRoot, { ...journal, status: "committing" });
  throwIfAborted(signal, true, planId);
  await commitChange(root, transactionRoot, configChange);

  const receipt = createReceipt(computed.plan, releaseVersion);
  await writeReceipt(metadata.receipts, receipt);
  await fs.rm(transactionRoot, { recursive: true, force: true }).catch(() => {});

  return {
    status: "applied",
    plan_id: planId,
    from_schema_version: computed.plan.from_schema_version,
    to_schema_version: computed.plan.to_schema_version,
    receipt_path: receiptRelativePath(planId)
  };
}

export async function recoverMigration({ aiosPath, planId = null }) {
  const root = requireAiosPath(aiosPath);
  if (planId !== null) assertPlanId(planId);

  const configState = await readConfigState(root);
  assertSupportedSchema(configState.version);
  await assertMetadataOwnedIfPresent(root);

  const activeTransactions = await listActiveTransactions(root);
  if (activeTransactions.length === 0) {
    if (planId && await readReceipt(root, planId)) {
      return { status: "already_applied", plan_id: planId, schema_version: configState.version };
    }
    return { status: "nothing_to_recover", schema_version: configState.version };
  }

  const selectedPlanId = selectTransaction(activeTransactions, planId);
  const transactionRoot = transactionPath(root, selectedPlanId);
  const journal = await readJournal(transactionRoot);
  if (!journal) {
    await assertTransactionHasNoCommittedState(transactionRoot);
    await fs.rm(transactionRoot, { recursive: true, force: true });
    return { status: "rolled_back", plan_id: selectedPlanId, schema_version: configState.version };
  }
  validateJournal(journal, selectedPlanId);

  const receipt = await readReceipt(root, selectedPlanId);
  if (receipt) {
    validateReceipt(receipt, selectedPlanId);
    if (compareVersions(configState.version, receipt.to_schema_version) < 0) {
      throw new MigrationError(
        "RECEIPT_STATE_MISMATCH",
        `Receipt ${selectedPlanId} exists, but aios.json does not contain its committed schema.`
      );
    }
    await removePendingReceipt(root, selectedPlanId);
    await fs.rm(transactionRoot, { recursive: true, force: true });
    return { status: "already_applied", plan_id: selectedPlanId, schema_version: configState.version };
  }

  if (journal.status === "preparing" || journal.status === "prepared") {
    await removePendingReceipt(root, selectedPlanId);
    await fs.rm(transactionRoot, { recursive: true, force: true });
    return { status: "rolled_back", plan_id: selectedPlanId, schema_version: configState.version };
  }

  for (const operation of [...journal.operations].reverse()) {
    await restoreOperation(root, transactionRoot, operation);
  }
  await removePendingReceipt(root, selectedPlanId);
  await fs.rm(transactionRoot, { recursive: true, force: true });

  const restoredConfig = await readConfigState(root);
  return { status: "rolled_back", plan_id: selectedPlanId, schema_version: restoredConfig.version };
}

async function buildPreviewForRoot(root, configState) {
  if (configState.version === schemaVersion) return buildPreview(configState);
  const ignore = await readOptionalRegularFile(path.join(root, ".gitignore"), ".gitignore");
  return buildPreview(configState, {
    files: new Map([
      ["aios.json", configState.bytes],
      ...(ignore ? [[".gitignore", ignore.bytes]] : [])
    ]),
    modes: new Map([
      ["aios.json", configState.mode],
      ...(ignore ? [[".gitignore", ignore.mode]] : [])
    ])
  });
}

function buildPreview(configState, migrationState = null) {
  if (configState.version === schemaVersion) {
    return {
      status: "current",
      schema_version: schemaVersion,
      current_schema_version: schemaVersion,
      protected_shelves: [...PROTECTED_SHELVES]
    };
  }

  const chain = migrationChain(configState.version);
  const files = migrationState?.files || new Map([["aios.json", configState.bytes]]);
  const modes = migrationState?.modes || new Map([["aios.json", configState.mode]]);
  const originalFiles = new Map(files);
  const summaries = new Map();
  const ownerships = new Map();

  for (const migration of chain) {
    for (const change of migration.migrate(files)) {
      assertWritableMigrationPath(change.path);
      if (!Buffer.isBuffer(change.after)) {
        throw new MigrationError("INVALID_REGISTRY", `${migration.id} did not produce bytes for ${change.path}.`);
      }
      files.set(change.path, change.after);
      ownerships.set(change.path, change.ownership);
      const previous = summaries.get(change.path) || [];
      previous.push(change.summary);
      summaries.set(change.path, previous);
    }
  }

  const changes = [];
  for (const [relativePath, after] of files) {
    const before = originalFiles.get(relativePath) || null;
    if (before && before.equals(after)) continue;
    changes.push({
      path: relativePath,
      before,
      after,
      before_mode: modes.get(relativePath) ?? null,
      after_mode: modes.get(relativePath) ?? 0o644,
      ownership: ownerships.get(relativePath),
      summary: (summaries.get(relativePath) || []).join(" ")
    });
  }
  changes.sort((left, right) => {
    if (left.path === "aios.json") return 1;
    if (right.path === "aios.json") return -1;
    return left.path.localeCompare(right.path);
  });

  const planBody = {
    schema: PLAN_SCHEMA,
    from_schema_version: configState.version,
    to_schema_version: schemaVersion,
    migrations: chain.map(({ id, from, to, summary }) => ({ id, from, to, summary })),
    operations: changes.map(publicOperation),
    protected_shelves: [...PROTECTED_SHELVES]
  };
  // Plan identity pins the planned operations only. The preserved-paths
  // inventory is receipt material and may legitimately grow between preview
  // and apply (memory appends, new signals); hashing it would strand valid plans.
  const planId = `migrate-${versionToken(configState.version)}-to-${versionToken(schemaVersion)}-${sha256(canonicalJson(planBody)).slice(0, 16)}`;
  const plan = { ...planBody, preserved_paths: [], plan_id: planId };

  return { status: "ready", plan, changes };
}

function publicPreview(preview) {
  if (preview.status !== "ready") return preview;
  return { status: preview.status, plan: preview.plan };
}

async function readConfigState(root, fileSystem = fs, { maxBytes = Infinity } = {}) {
  const filePath = path.join(root, "aios.json");
  let snapshot;
  try {
    snapshot = await readContainedFile(root, filePath, {
      filesystem: fileSystem,
      maxBytes,
      returnSnapshot: true,
      tooLargeCode: "CONFIG_TOO_LARGE"
    });
  } catch (error) {
    if (error instanceof ContainedReadError) {
      if (error.code === "CONFIG_TOO_LARGE") {
        throw new MigrationError("CONFIG_TOO_LARGE", "aios.json exceeds the 1 MiB compatibility-inspection limit.");
      }
      if (error.code === "DOTAIOS_CONTEXT_SOURCE_CHANGED") {
        throw new MigrationError("CONFIG_CHANGED", "aios.json changed during compatibility inspection.");
      }
      throw new MigrationError("UNSAFE_FILE", "aios.json must be a contained regular file.");
    }
    throw error;
  }
  if (snapshot === null) {
    throw new MigrationError("MISSING_FILE", "Required migration file is missing: aios.json");
  }
  const { content: bytes, stats } = snapshot;
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new MigrationError("INVALID_CONFIG_ENCODING", "aios.json must be valid UTF-8.");
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new MigrationError("INVALID_CONFIG", `Cannot migrate ${filePath}: it is not valid JSON.`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new MigrationError("INVALID_CONFIG", `Cannot migrate ${filePath}: the top-level value must be an object.`);
  }
  if (!isVersion(config.schema_version)) {
    throw new MigrationError("INVALID_SCHEMA", "aios.json must contain a schema_version in x.y.z form before it can be migrated.");
  }
  return { bytes, config, mode: stats.mode & 0o777, version: config.schema_version };
}

function assertSupportedSchema(version) {
  const comparison = compareVersions(version, schemaVersion);
  if (comparison > 0) {
    throw new MigrationError(
      "FUTURE_SCHEMA",
      `This folder uses schema ${version}, newer than this DotAIOS build supports (${schemaVersion}). Refusing to write.`,
      { folder_schema_version: version, current_schema_version: schemaVersion }
    );
  }
  if (comparison < 0 && !MIGRATIONS.some((migration) => migration.from === version)) {
    throw new MigrationError(
      "UNSUPPORTED_SCHEMA",
      `No migration path is registered from schema ${version} to ${schemaVersion}. Refusing to guess.`
    );
  }
}

function migrationChain(fromVersion) {
  const chain = [];
  let cursor = fromVersion;
  while (cursor !== schemaVersion) {
    const migration = MIGRATIONS.find((candidate) => candidate.from === cursor);
    if (!migration) {
      throw new MigrationError("UNSUPPORTED_SCHEMA", `No migration path is registered from schema ${cursor} to ${schemaVersion}.`);
    }
    chain.push(migration);
    cursor = migration.to;
    if (chain.length > MIGRATIONS.length) {
      throw new MigrationError("INVALID_REGISTRY", "Migration registry contains a cycle.");
    }
  }
  return chain;
}

function replaceSchemaVersion(bytes, fromVersion, toVersion) {
  const text = bytes.toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MigrationError("INVALID_CONFIG", "aios.json is not valid JSON.");
  }
  if (parsed.schema_version !== fromVersion) {
    throw new MigrationError("PLAN_CHANGED", `Expected schema ${fromVersion}, found ${parsed.schema_version || "none"}.`);
  }

  const matches = [...text.matchAll(/"schema_version"\s*:\s*"([^"]*)"/g)];
  if (matches.length !== 1 || matches[0][1] !== fromVersion) {
    throw new MigrationError(
      "UNSAFE_CONFIG_LAYOUT",
      "aios.json does not contain exactly one plain-text schema_version field; refusing to rewrite its formatting."
    );
  }
  const match = matches[0];
  const valueOffset = match.index + match[0].lastIndexOf(fromVersion);
  const updated = `${text.slice(0, valueOffset)}${toVersion}${text.slice(valueOffset + fromVersion.length)}`;
  const verified = JSON.parse(updated);
  if (verified.schema_version !== toVersion) {
    throw new MigrationError("INVALID_REGISTRY", "Schema migration did not produce the expected config version.");
  }
  return Buffer.from(updated, "utf8");
}

function appendWorkspaceIgnore(bytes) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new MigrationError("UNSAFE_IGNORE_FILE", ".gitignore is not valid UTF-8; refusing to rewrite it.");
  }
  if (endsWithManagedWorkspaceIgnoreRule(text)) return bytes;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const separator = text.length > 0 && !text.endsWith("\n") ? eol : "";
  return Buffer.from(`${text}${separator}/workspaces/${eol}`, "utf8");
}

function publicOperation(change) {
  return {
    path: change.path,
    action: change.before ? "replace" : "create",
    ownership: change.ownership,
    summary: change.summary,
    before_sha256: change.before ? sha256(change.before) : null,
    after_sha256: sha256(change.after),
    before_bytes: change.before?.length || 0,
    after_bytes: change.after.length
  };
}

function createJournal(plan, changes) {
  const changesByPath = new Map(changes.map((change) => [change.path, change]));
  return {
    schema: JOURNAL_SCHEMA,
    plan_id: plan.plan_id,
    status: "preparing",
    created_at: new Date().toISOString(),
    from_schema_version: plan.from_schema_version,
    to_schema_version: plan.to_schema_version,
    migrations: plan.migrations.map(({ id }) => id),
    operations: plan.operations.map((operation) => {
      const change = changesByPath.get(operation.path);
      if (!change) {
        throw new MigrationError("INVALID_REGISTRY", `Migration plan is missing internal state for ${operation.path}.`);
      }
      return {
        path: operation.path,
        action: operation.action,
        before_sha256: operation.before_sha256,
        after_sha256: operation.after_sha256,
        before_mode: change.before_mode,
        after_mode: change.after_mode,
        backup_path: operation.before_sha256 ? path.posix.join("backups", operation.path) : null
      };
    })
  };
}

async function writeInitialJournal(transactionRoot, journal) {
  await fs.mkdir(path.join(transactionRoot, "backups"), { recursive: true });
  await fs.mkdir(path.join(transactionRoot, "staged"), { recursive: true });
  await fs.writeFile(
    path.join(transactionRoot, "journal.json"),
    `${JSON.stringify(journal, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
}

async function stageTransaction(root, transactionRoot, changes, journal) {
  for (const change of changes) {
    if (change.before) {
      const backupPath = path.join(transactionRoot, "backups", ...change.path.split("/"));
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.writeFile(backupPath, change.before, { flag: "wx", mode: 0o600 });
    }
    const stagedPath = path.join(transactionRoot, "staged", ...change.path.split("/"));
    await fs.mkdir(path.dirname(stagedPath), { recursive: true });
    const stagedMode = change.after_mode ?? 0o644;
    await fs.writeFile(stagedPath, change.after, { flag: "wx", mode: stagedMode });
    await fs.chmod(stagedPath, stagedMode);
  }
  await updateJournal(transactionRoot, { ...journal, status: "prepared" });
  await assertChangesUnchanged(root, changes);
}

async function updateJournal(transactionRoot, journal) {
  const destination = path.join(transactionRoot, "journal.json");
  const pending = path.join(transactionRoot, "journal.json.next");
  await fs.writeFile(pending, `${JSON.stringify(journal, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await fs.rename(pending, destination);
  } finally {
    await fs.rm(pending, { force: true }).catch(() => {});
  }
}

async function commitChange(root, transactionRoot, change) {
  await assertChangeUnchanged(root, change);
  const destination = path.join(root, ...change.path.split("/"));
  const stagedPath = path.join(transactionRoot, "staged", ...change.path.split("/"));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(stagedPath, destination);
}

async function assertChangesUnchanged(root, changes) {
  for (const change of changes) await assertChangeUnchanged(root, change);
}

async function assertChangeUnchanged(root, change) {
  const destination = path.join(root, ...change.path.split("/"));
  if (!change.before) {
    try {
      await fs.lstat(destination);
      throw concurrentEdit(change.path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return;
    }
  }
  const stats = await lstatRegularFile(destination, change.path);
  if ((stats.mode & 0o777) !== change.before_mode) throw concurrentEdit(change.path);
  const current = await fs.readFile(destination);
  if (!current.equals(change.before)) throw concurrentEdit(change.path);
}

async function restoreOperation(root, transactionRoot, operation) {
  assertWritableMigrationPath(operation.path);
  const destination = path.join(root, ...operation.path.split("/"));
  const current = await readOptionalRegularFile(destination, operation.path);
  const currentHash = current ? sha256(current.bytes) : null;

  // Original bytes mean this operation never committed. Its current mode may
  // be a legitimate concurrent chmod, so recovery must leave it untouched.
  if (currentHash === operation.before_sha256) return;
  if (currentHash !== operation.after_sha256) {
    throw new MigrationError(
      "CONCURRENT_EDIT",
      `${operation.path} changed after the interrupted migration. Recovery will not overwrite it.`,
      { path: operation.path }
    );
  }
  // New journals bind both bytes and permissions. Once the migrated bytes are
  // present, a different mode is a post-interruption user edit and must not be
  // overwritten by rollback. Legacy journals did not record modes, so retain
  // their historical hash-only recovery behavior.
  if (operation.after_mode !== undefined && current?.mode !== operation.after_mode) {
    throw concurrentEdit(operation.path);
  }

  if (!operation.before_sha256) {
    await fs.rm(destination);
    return;
  }
  const backupPath = path.join(transactionRoot, ...operation.backup_path.split("/"));
  const backup = await fs.readFile(backupPath);
  if (sha256(backup) !== operation.before_sha256) {
    throw new MigrationError("INVALID_BACKUP", `Backup for ${operation.path} does not match the journal.`);
  }
  const recoveryPath = path.join(transactionRoot, "recovery", ...operation.path.split("/"));
  // Journals written before mode metadata was added remain recoverable. Their
  // staged replacement inherited the original mode, so use its current mode
  // when available; otherwise retain the legacy private fallback.
  const recoveryMode = operation.before_mode ?? current?.mode ?? 0o600;
  const recoveryIdentity = await prepareRecoveryReplacement(
    recoveryPath,
    backup,
    recoveryMode,
    operation.path
  );
  await assertRecoveryReplacementExact(
    recoveryPath,
    backup,
    recoveryMode,
    recoveryIdentity,
    operation.path
  );
  await fs.rename(recoveryPath, destination);
}

async function prepareRecoveryReplacement(recoveryPath, expectedBytes, mode, label) {
  await ensureDirectory(path.dirname(recoveryPath));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    let created = false;
    try {
      try {
        handle = await fs.open(
          recoveryPath,
          fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW || 0)
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw recoveryResidueError(label);
        try {
          handle = await fs.open(
            recoveryPath,
            fsConstants.O_CREAT
              | fsConstants.O_EXCL
              | fsConstants.O_RDWR
              | (fsConstants.O_NOFOLLOW || 0),
            0o600
          );
          created = true;
        } catch (createError) {
          if (createError.code === "EEXIST") continue;
          throw createError;
        }
      }

      if (created) {
        await handle.writeFile(expectedBytes);
        await handle.sync();
      }
      const stats = await handle.stat();
      if (!stats.isFile() || stats.nlink !== 1) throw recoveryResidueError(label);
      const bytes = await readHandleBytes(handle, stats.size);
      if (!bytes.equals(expectedBytes)) throw recoveryResidueError(label);

      // A stop can happen after exclusive creation but before chmod. Exact
      // bytes at this deterministic, owned transaction path are sufficient to
      // resume; normalize them back to the journaled mode through the verified
      // open handle before installing anything in the AIOS root.
      await handle.chmod(mode);
      await handle.sync();
      return `${stats.dev}:${stats.ino}`;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  throw recoveryResidueError(label);
}

async function assertRecoveryReplacementExact(
  recoveryPath,
  expectedBytes,
  mode,
  expectedIdentity,
  label
) {
  let handle;
  try {
    handle = await fs.open(
      recoveryPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)
    );
    const stats = await handle.stat();
    if (
      !stats.isFile()
      || stats.nlink !== 1
      || `${stats.dev}:${stats.ino}` !== expectedIdentity
      || (stats.mode & 0o777) !== mode
    ) {
      throw recoveryResidueError(label);
    }
    const bytes = await readHandleBytes(handle, stats.size);
    if (!bytes.equals(expectedBytes)) throw recoveryResidueError(label);
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw recoveryResidueError(label);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readHandleBytes(handle, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === size ? bytes : bytes.subarray(0, offset);
}

function recoveryResidueError(label) {
  return new MigrationError(
    "UNSAFE_RECOVERY_RESIDUE",
    `Recovery staging file for ${label} is changed, linked, or foreign. Refusing to overwrite it or the AIOS file.`,
    { path: label }
  );
}

function createReceipt(plan, releaseVersion) {
  const transactionPath = path.posix.join(".dotaios", "migrations", "transactions", plan.plan_id);
  return {
    schema: RECEIPT_SCHEMA,
    plan_id: plan.plan_id,
    from_schema_version: plan.from_schema_version,
    to_schema_version: plan.to_schema_version,
    migrations: plan.migrations.map(({ id }) => id),
    operations: plan.operations.map(({ path: relativePath, before_sha256, after_sha256 }) => ({
      path: relativePath,
      before_sha256,
      after_sha256
    })),
    preserved_paths: plan.preserved_paths || [],
    recovery: {
      strategy: "journaled-backup",
      journal_schema: JOURNAL_SCHEMA,
      transaction_path: transactionPath,
      rollback_command: `dotaios migrate --recover ${plan.plan_id}`,
      backups: plan.operations.map((operation) => ({
        path: operation.path,
        backup_path: operation.before_sha256
          ? path.posix.join(transactionPath, "backups", operation.path)
          : null,
        before_sha256: operation.before_sha256,
      })),
    },
    release_version: releaseVersion,
    applied_at: new Date().toISOString()
  };
}

async function writeReceipt(receiptsRoot, receipt) {
  const destination = path.join(receiptsRoot, `${receipt.plan_id}.json`);
  const pending = `${destination}.pending`;
  await fs.writeFile(pending, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await fs.link(pending, destination);
  } finally {
    await fs.rm(pending, { force: true }).catch(() => {});
  }
}

async function readReceipt(root, planId) {
  const filePath = receiptPath(root, planId);
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new MigrationError("UNSAFE_METADATA", `Migration receipt is not a regular file: ${filePath}`);
  }
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    throw new MigrationError("INVALID_RECEIPT", `Migration receipt is not valid JSON: ${filePath}`);
  }
}

function validateReceipt(receipt, planId) {
  if (
    receipt?.schema !== RECEIPT_SCHEMA ||
    receipt.plan_id !== planId ||
    !isVersion(receipt.from_schema_version) ||
    !isVersion(receipt.to_schema_version) ||
    typeof receipt.release_version !== "string" ||
    !Array.isArray(receipt.operations)
  ) {
    throw new MigrationError("INVALID_RECEIPT", `Migration receipt ${planId} is invalid; refusing to trust it.`);
  }
}

async function readJournal(transactionRoot) {
  const filePath = path.join(transactionRoot, "journal.json");
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function validateJournal(journal, planId) {
  if (
    journal?.schema !== JOURNAL_SCHEMA ||
    journal.plan_id !== planId ||
    !["preparing", "prepared", "applying", "committing"].includes(journal.status) ||
    !Array.isArray(journal.operations)
  ) {
    throw new MigrationError("INVALID_JOURNAL", `Migration journal ${planId} is invalid; refusing automatic recovery.`);
  }
  for (const operation of journal.operations) {
    assertWritableMigrationPath(operation.path);
    const legacyModes = operation.before_mode === undefined && operation.after_mode === undefined;
    const validBeforeMode = operation.before_sha256
      ? isPortableMode(operation.before_mode)
      : operation.before_mode === null;
    if (
      typeof operation.after_sha256 !== "string" ||
      (!legacyModes && (!validBeforeMode || !isPortableMode(operation.after_mode)))
    ) {
      throw new MigrationError("INVALID_JOURNAL", `Migration journal ${planId} has an invalid operation.`);
    }
  }
}

function isPortableMode(mode) {
  return Number.isInteger(mode) && mode >= 0 && mode <= 0o777;
}

async function assertTransactionHasNoCommittedState(transactionRoot) {
  const entries = await listFilesRecursively(transactionRoot);
  const unexpected = entries.filter((entry) => (
    !entry.endsWith("journal.json") && !entry.endsWith("journal.json.next")
  ));
  if (unexpected.length > 0) {
    throw new MigrationError("INVALID_JOURNAL", "Interrupted transaction has no readable journal; refusing to remove its files automatically.");
  }
}

async function listFilesRecursively(root) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(entries.map(async (entry) => {
    const resolved = path.join(root, entry.name);
    return entry.isDirectory() ? listFilesRecursively(resolved) : [resolved];
  }));
  return nested.flat();
}

async function inventoryPreservedPaths(root) {
  const inventory = [];
  for (const shelf of PROTECTED_SHELVES) {
    const relativeRoot = shelf.replace(/\/$/, "");
    await inventoryPath(path.join(root, relativeRoot), relativeRoot, inventory);
  }
  return inventory.sort((left, right) => left.path.localeCompare(right.path));
}

async function inventoryPath(absolutePath, relativePath, inventory) {
  let stats;
  try {
    stats = await fs.lstat(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  if (stats.isSymbolicLink()) {
    inventory.push({ path: relativePath, kind: "symlink", bytes: 0, sha256: null });
    return;
  }
  if (stats.isDirectory()) {
    inventory.push({ path: relativePath, kind: "directory", bytes: 0, sha256: null });
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      await inventoryPath(
        path.join(absolutePath, entry.name),
        path.posix.join(relativePath, entry.name),
        inventory,
      );
    }
    return;
  }
  if (!stats.isFile()) {
    inventory.push({ path: relativePath, kind: "other", bytes: 0, sha256: null });
    return;
  }

  const bytes = await fs.readFile(absolutePath);
  inventory.push({
    path: relativePath,
    kind: "file",
    bytes: bytes.length,
    sha256: sha256(bytes),
  });
}

async function ensureOwnedMetadata(root) {
  const dotaiosRoot = path.join(root, ".dotaios");
  const migrationsRoot = path.join(dotaiosRoot, "migrations");
  await ensureDirectory(dotaiosRoot);
  await ensureDirectory(migrationsRoot);

  const ownerPath = path.join(migrationsRoot, "owner.json");
  const ownerExists = Boolean(await lstatOptionalRegularFile(ownerPath, ".dotaios/migrations/owner.json"));
  if (!ownerExists) {
    const entries = await fs.readdir(migrationsRoot);
    if (entries.length > 0) {
      throw new MigrationError("UNOWNED_METADATA", `${migrationsRoot} already contains files but has no DotAIOS ownership marker.`);
    }
    await fs.writeFile(ownerPath, OWNER_CONTENT, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } else {
    await assertOwnerContent(ownerPath);
  }

  const transactions = path.join(migrationsRoot, "transactions");
  const receipts = path.join(migrationsRoot, "receipts");
  await ensureDirectory(transactions);
  await ensureDirectory(receipts);
  return { root: migrationsRoot, transactions, receipts };
}

async function assertMetadataOwnedIfPresent(root) {
  const dotaiosRoot = path.join(root, ".dotaios");
  let dotaiosStats;
  try {
    dotaiosStats = await fs.lstat(dotaiosRoot);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!dotaiosStats.isDirectory() || dotaiosStats.isSymbolicLink()) {
    throw new MigrationError("UNSAFE_METADATA", `${dotaiosRoot} must be a real directory, not a link or file.`);
  }

  const migrationsRoot = migrationMetadataPath(root);
  let stats;
  try {
    stats = await fs.lstat(migrationsRoot);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new MigrationError("UNSAFE_METADATA", `${migrationsRoot} must be a real directory, not a link or file.`);
  }
  const ownerPath = path.join(migrationsRoot, "owner.json");
  if (!await lstatOptionalRegularFile(ownerPath, ".dotaios/migrations/owner.json")) {
    const entries = await fs.readdir(migrationsRoot);
    if (entries.length === 0) return;
    throw new MigrationError("UNOWNED_METADATA", `${migrationsRoot} has no DotAIOS ownership marker. Refusing to use it.`);
  }
  await assertOwnerContent(ownerPath);
  for (const child of ["transactions", "receipts"]) {
    const childPath = path.join(migrationsRoot, child);
    try {
      const childStats = await fs.lstat(childPath);
      if (!childStats.isDirectory() || childStats.isSymbolicLink()) {
        throw new MigrationError("UNSAFE_METADATA", `${childPath} must be a real directory.`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function assertOwnerContent(ownerPath) {
  if (await fs.readFile(ownerPath, "utf8") !== OWNER_CONTENT) {
    throw new MigrationError("UNOWNED_METADATA", `${ownerPath} is not a recognized DotAIOS ownership marker.`);
  }
}

async function listActiveTransactions(root) {
  await assertMetadataOwnedIfPresent(root);
  const transactionsRoot = path.join(migrationMetadataPath(root), "transactions");
  let entries;
  try {
    entries = await fs.readdir(transactionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new MigrationError("UNSAFE_METADATA", `Unexpected entry in migration transactions: ${entry.name}`);
    }
    assertPlanId(entry.name);
    ids.push(entry.name);
  }
  return ids.sort();
}

function selectTransaction(activeTransactions, requestedPlanId) {
  if (requestedPlanId) {
    if (!activeTransactions.includes(requestedPlanId)) {
      throw new MigrationError("TRANSACTION_NOT_FOUND", `No interrupted transaction found for ${requestedPlanId}.`);
    }
    return requestedPlanId;
  }
  if (activeTransactions.length !== 1) {
    throw new MigrationError(
      "AMBIGUOUS_RECOVERY",
      `More than one interrupted migration exists. Pass --recover <plan-id>: ${activeTransactions.join(", ")}`
    );
  }
  return activeTransactions[0];
}

async function removePendingReceipt(root, planId) {
  await fs.rm(`${receiptPath(root, planId)}.pending`, { force: true }).catch(() => {});
}

function receiptPath(root, planId) {
  return path.join(migrationMetadataPath(root), "receipts", `${planId}.json`);
}

function receiptRelativePath(planId) {
  return path.posix.join(".dotaios", "migrations", "receipts", `${planId}.json`);
}

function transactionPath(root, planId) {
  return path.join(migrationMetadataPath(root), "transactions", planId);
}

function migrationMetadataPath(root) {
  return path.join(root, ".dotaios", "migrations");
}

async function ensureDirectory(directory) {
  try {
    await fs.mkdir(directory);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new MigrationError("UNSAFE_METADATA", `${directory} must be a real directory, not a link or file.`);
  }
}

async function lstatRegularFile(filePath, label) {
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new MigrationError("MISSING_FILE", `Required migration file is missing: ${label}`);
    }
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new MigrationError("UNSAFE_FILE", `${label} must be a regular file, not a link or directory.`);
  }
  return stats;
}

async function lstatOptionalRegularFile(filePath, label) {
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new MigrationError("UNSAFE_FILE", `${label} must be a regular file, not a link or directory.`);
  }
  return stats;
}

async function readOptionalRegularFile(filePath, label) {
  try {
    const stats = await fs.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new MigrationError("UNSAFE_FILE", `${label} must be a regular file during recovery.`);
    }
    return { bytes: await fs.readFile(filePath), mode: stats.mode & 0o777 };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function assertWritableMigrationPath(relativePath) {
  if (!WRITABLE_PATHS.has(relativePath)) {
    throw new MigrationError("INVALID_REGISTRY", `Migration registry is not allowed to write ${relativePath}.`);
  }
  if (PROTECTED_SHELVES.some((shelf) => relativePath === shelf.slice(0, -1) || relativePath.startsWith(shelf))) {
    throw new MigrationError("PROTECTED_SHELF", `Migration registry attempted to write protected shelf ${relativePath}.`);
  }
}

function throwIfAborted(signal, transactionStarted, planId = null) {
  if (!signal?.aborted) return;
  if (transactionStarted) {
    throw new MigrationError(
      "APPLY_INTERRUPTED",
      `Migration ${planId} was interrupted after its journal was prepared. Run recovery before applying again.`,
      { plan_id: planId }
    );
  }
  throw new MigrationError("APPLY_ABORTED", "Migration was cancelled before any transaction files were written.");
}

function concurrentEdit(relativePath) {
  return new MigrationError(
    "CONCURRENT_EDIT",
    `${relativePath} changed after preview. Refusing to overwrite it; recover the transaction and preview again.`,
    { path: relativePath }
  );
}

function recoveryRequired(transactionIds) {
  return new MigrationError(
    "RECOVERY_REQUIRED",
    `Interrupted migration state exists for ${transactionIds.join(", ")}. Run dotaios migrate --recover before applying another plan.`,
    { transaction_ids: transactionIds }
  );
}

function requireAiosPath(aiosPath) {
  if (typeof aiosPath !== "string" || aiosPath.trim() === "") {
    throw new MigrationError("INVALID_PATH", "An AIOS folder path is required.");
  }
  return path.resolve(aiosPath);
}

function assertPlanId(planId) {
  if (typeof planId !== "string" || !/^migrate-[0-9_]+-to-[0-9_]+-[a-f0-9]{16}$/.test(planId)) {
    throw new MigrationError("INVALID_PLAN_ID", `Invalid migration plan id: ${String(planId)}`);
  }
}

function versionToken(version) {
  return version.replaceAll(".", "_");
}

function isVersion(value) {
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}

function compareVersions(left, right) {
  if (!isVersion(left) || !isVersion(right)) {
    throw new MigrationError("INVALID_SCHEMA", `Invalid schema version comparison: ${left} and ${right}`);
  }
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] < rightParts[index] ? -1 : 1;
  }
  return 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function validateRegistry() {
  let expectedFrom = MIGRATIONS[0]?.from;
  for (const migration of MIGRATIONS) {
    if (!isVersion(migration.from) || !isVersion(migration.to) || migration.from !== expectedFrom) {
      throw new Error("DotAIOS migration registry must be an ordered, contiguous version chain.");
    }
    if (compareVersions(migration.from, migration.to) >= 0) {
      throw new Error(`DotAIOS migration ${migration.id} must advance the schema version.`);
    }
    expectedFrom = migration.to;
  }
  if (expectedFrom !== schemaVersion) {
    throw new Error(`DotAIOS migration registry must end at schema ${schemaVersion}.`);
  }
}
