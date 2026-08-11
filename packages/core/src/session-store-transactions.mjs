import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import { deriveProjectionRows, strictDecodeUtf8 } from "./session-codec.mjs";
import { inspectContainedDirectory } from "./contained-read.mjs";
import {
  assertOwnedFileStats,
  ensureOwnedDirectory,
  sameFileIdentity,
  syncOwnedDirectory,
} from "./owned-state.mjs";
import { isPathWithinLexically } from "./paths.mjs";
import { parseSessionRelativePath } from "./session-paths.mjs";
import {
  fileIdentity,
  sameDirectoryNamespaceIdentity,
  sameFileIdentityValue,
  sameNodeExceptMode,
  sameNodeIgnoringLinkCount,
  sameOptionalFileIdentity,
  samePrivatizedFileIdentity,
  validFileIdentity,
} from "./session-store-files.mjs";

const TRANSACTION_FORMAT = "dotaios-session-store-transaction/v1";
const READ_NOFOLLOW_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_TRANSACTION_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_OPERATIONAL_ENTRIES = 64;
const MAX_TRANSACTION_CHILD_ENTRIES = 4;
const OPERATION_LOCK_UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
export function createSessionTransactionManager(context) {
  const {
    aiosPath,
    dotaiosRoot,
    faultInjector,
    filesystem,
    indexPath,
    loadSnapshot,
    pendingPath,
    projectionBytes,
    refuse,
    sessionsRoot,
    storeRoot,
  } = context;
  let operationalRootSnapshot = null;
  async function prepareMutation(checkDeadline) {
    checkDeadline();
    await hasPendingTransaction();
    checkDeadline();
    await cleanupDiscardedBootstraps(checkDeadline);
    checkDeadline();
    await cleanupBootstrappingTransactions(checkDeadline);
    checkDeadline();
    await cleanupDiscardedTransactions(checkDeadline);
    checkDeadline();
    await cleanupClosedTransactions(checkDeadline);
    checkDeadline();
    await cleanupUnpublishedTransactions(checkDeadline);
    checkDeadline();
    await recoverPending(checkDeadline);
    checkDeadline();
  }
  async function publishMutation({
    kind,
    targetRelative,
    canonicalBefore,
    canonicalBeforeIdentity = null,
    canonicalAfter,
    projectionBefore,
    projectionBeforeIdentity,
    projectionAfter,
  }) {
    if (await hasPendingTransaction()) refuse("DOTAIOS_SESSION_STORE_POISONED");
    const transactionId = crypto.randomUUID();
    const bootstrapPath = path.join(storeRoot, `.bootstrap-${transactionId}`);
    const privatePath = path.join(storeRoot, `.private-${transactionId}`);
    await createOwnedTransactionDirectory(bootstrapPath);
    await fireFault("after_bootstrap_directory", { kind });
    const manifest = Object.freeze({
      format: TRANSACTION_FORMAT,
      id: transactionId,
      kind,
      target: targetRelative,
      canonical_before: canonicalBefore === null ? null : sha256(canonicalBefore),
      canonical_identity_before: canonicalBeforeIdentity,
      canonical_after: canonicalAfter === null ? null : sha256(canonicalAfter),
      projection_before: projectionBefore === null ? null : sha256(projectionBefore),
      projection_identity_before: projectionBeforeIdentity,
      projection_after: sha256(projectionAfter),
    });
    await writeBootstrapManifest(
      path.join(bootstrapPath, "manifest.json"),
      `${JSON.stringify(manifest)}\n`,
      { kind },
    );
    await fireFault("after_bootstrap_manifest", { kind });
    if (canonicalAfter !== null) {
      await writeOwned(path.join(bootstrapPath, "canonical.md"), canonicalAfter);
      await fireFault("after_bootstrap_canonical", { kind });
    }
    await writeOwned(path.join(bootstrapPath, "index.jsonl"), projectionAfter);
    await fireFault("after_bootstrap_projection", { kind });
    await syncOwnedDirectory(bootstrapPath, { filesystem });
    const bootstrapIdentity = fileIdentity(await filesystem.lstat(bootstrapPath));
    await renameOperationalDirectory(bootstrapPath, privatePath, bootstrapIdentity, { destinationMissing: true });
    await fireFault("after_private", { kind });
    await fireFault("before_pending", { kind });
    await assertPublicationPrecondition({ kind, projectionBefore, projectionBeforeIdentity, projectionAfter });
    const privateIdentity = fileIdentity(await filesystem.lstat(privatePath));
    await renameOperationalDirectory(privatePath, pendingPath, privateIdentity, { destinationMissing: true });
    await fireFault("after_pending", { kind });
    await completePending();
  }

  async function assertPublicationPrecondition({ kind, projectionBefore, projectionBeforeIdentity, projectionAfter }) {
    const snapshot = await loadSnapshot({
      mutation: true,
      report: kind === "reconcile",
      deleteExact: kind === "delete",
    });
    if (snapshot.invalidMarkdown.length > 0 || snapshot.unsafeCanonical) {
      refuse("DOTAIOS_SESSION_INVENTORY_CHANGED");
    }
    if (snapshot.projectionText !== projectionBefore) {
      refuse("DOTAIOS_SESSION_INVENTORY_CHANGED");
    }
    if (!sameOptionalFileIdentity(snapshot.projectionIdentity, projectionBeforeIdentity)) {
      refuse("DOTAIOS_SESSION_INVENTORY_CHANGED");
    }
    const expectedCanonicalProjection = kind === "reconcile"
      ? projectionAfter
      : (projectionBefore ?? "");
    if (projectionBytes(snapshot.derivedRows) !== expectedCanonicalProjection) {
      refuse("DOTAIOS_SESSION_INVENTORY_CHANGED");
    }
  }

  async function completePending(checkDeadline = () => {}) {
    const manifest = await readManifest();
    if (!manifest) return;
    checkDeadline();
    if (manifest.kind === "delete") await completeDelete(manifest);
    else if (manifest.kind === "reconcile") await completeProjection(manifest);
    else await completeCapture(manifest);
    checkDeadline();
    await fireFault("before_cleanup", { kind: manifest.kind });
    await cleanupPending(manifest, checkDeadline);
    checkDeadline();
    await fireFault("after_cleanup", { kind: manifest.kind });
  }

  async function completeCapture(manifest) {
    const target = canonicalTarget(manifest.target);
    await ensureCanonicalParents(target, { kind: manifest.kind });
    const current = await observeRegularFile(target, { missing: true });
    if (current?.hash === manifest.canonical_after) {
      // Canonical publication completed before a crash.
    } else if (current === null && manifest.canonical_before === null) {
      await installStagedCanonical(target, manifest.canonical_after);
    } else if (matchesCanonicalBefore(current, manifest)) {
      if (manifest.canonical_before !== null) {
        const previous = path.join(pendingPath, "previous.md");
        const previousObservation = await prepareParkedCanonical(previous, manifest, { missing: true });
        if (previousObservation === null) {
          const moveSnapshots = await snapshotMoveNamespaces(target, previous);
          await filesystem.rename(target, previous);
          let moved;
          try {
            await assertMoveNamespacesUnchanged(moveSnapshots);
            await syncOwnedDirectory(path.dirname(target), { filesystem });
            await syncOwnedDirectory(pendingPath, { filesystem });
            moved = await observeRegularFile(previous);
          } catch {
            await restoreUnexpectedMovedNode(previous, target);
            refuse("DOTAIOS_SESSION_STORE_POISONED");
          }
          if (!matchesCanonicalBefore(moved, manifest)) {
            await restoreUnexpectedMovedNode(previous, target);
            refuse("DOTAIOS_SESSION_STORE_POISONED");
          }
          await privatizeParkedFile(previous, moved);
          await fireFault("after_canonical_move", { kind: manifest.kind });
        } else if (!matchesParkedCanonicalBefore(previousObservation, manifest)) {
          refuse("DOTAIOS_SESSION_STORE_POISONED");
        }
      }
      await installStagedCanonical(target, manifest.canonical_after);
    } else if (current === null && manifest.canonical_before !== null) {
      const previous = path.join(pendingPath, "previous.md");
      if (!matchesParkedCanonicalBefore(await prepareParkedCanonical(previous, manifest), manifest)) {
        refuse("DOTAIOS_SESSION_STORE_POISONED");
      }
      await installStagedCanonical(target, manifest.canonical_after);
    } else {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    await fireFault("after_canonical", { kind: manifest.kind });
    await completeProjection(manifest);
  }

  async function installStagedCanonical(target, expectedHash) {
    const staged = path.join(pendingPath, "canonical.md");
    await installStagedFile(staged, target, expectedHash);
  }

  async function installStagedFile(staged, target, expectedHash) {
    const stagedObservation = await observeRegularFile(staged, { owned: true });
    if (stagedObservation.hash !== expectedHash) refuse("DOTAIOS_SESSION_STORE_POISONED");
    const parentSnapshot = await snapshotPublicationParent(target);
    try {
      await filesystem.link(staged, target);
    } catch {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    const [linkedStaged, linkedTarget] = await Promise.all([
      filesystem.lstat(staged),
      filesystem.lstat(target),
    ]);
    if (
      !sameNodeIgnoringLinkCount(linkedStaged, linkedTarget)
      || !sameFileIdentityValue(fileIdentity(linkedStaged), stagedObservation.identity)
      || (process.platform !== "win32" && (linkedStaged.nlink !== 2 || linkedTarget.nlink !== 2))
    ) refuse("DOTAIOS_SESSION_STORE_POISONED");
    try {
      await assertPublicationParentUnchanged(target, parentSnapshot);
    } catch {
      await quarantineUnexpectedLinkedTarget(target, staged, stagedObservation);
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    await syncOwnedDirectory(path.dirname(target), { filesystem });
    await filesystem.unlink(staged);
    await syncOwnedDirectory(pendingPath, { filesystem });
    await syncOwnedDirectory(path.dirname(target), { filesystem });
    const final = await observeRegularFile(target);
    const finalStats = await filesystem.lstat(target);
    if (
      final.hash !== expectedHash
      || !sameFileIdentityValue(final.identity, stagedObservation.identity)
      || (process.platform !== "win32" && finalStats.nlink !== 1)
    ) refuse("DOTAIOS_SESSION_STORE_POISONED");
  }

  async function snapshotPublicationParent(target) {
    return snapshotPublicationDirectory(path.dirname(target));
  }

  async function assertPublicationParentUnchanged(target, expected) {
    const actual = await snapshotPublicationParent(target);
    if (!sameDirectoryNamespaceIdentity(expected, actual)) {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
  }

  async function quarantineUnexpectedLinkedTarget(target, staged, stagedObservation) {
    try {
      const [stagedStats, targetStats] = await Promise.all([
        filesystem.lstat(staged),
        filesystem.lstat(target),
      ]);
      if (
        !sameNodeIgnoringLinkCount(stagedStats, targetStats)
        || !sameFileIdentityValue(fileIdentity(stagedStats), stagedObservation.identity)
        || (process.platform !== "win32" && (stagedStats.nlink !== 2 || targetStats.nlink !== 2))
      ) {
        return false;
      }
      await filesystem.unlink(target);
      await syncOwnedDirectory(pendingPath, { filesystem });
      const retained = await observeRegularFile(staged, { owned: true });
      const retainedStats = await filesystem.lstat(staged);
      return retained.hash === stagedObservation.hash
        && sameFileIdentityValue(retained.identity, stagedObservation.identity)
        && (process.platform === "win32" || retainedStats.nlink === 1);
    } catch {
      return false;
    }
  }

  async function completeDelete(manifest) {
    const target = canonicalTarget(manifest.target);
    const trash = path.join(pendingPath, "deleted.md");
    const current = await observeRegularFile(target, { missing: true });
    const trashObservation = await prepareParkedCanonical(trash, manifest, { missing: true });
    if (matchesCanonicalBefore(current, manifest) && trashObservation === null) {
      const moveSnapshots = await snapshotMoveNamespaces(target, trash);
      await filesystem.rename(target, trash);
      let moved;
      try {
        await assertMoveNamespacesUnchanged(moveSnapshots);
        await syncOwnedDirectory(path.dirname(target), { filesystem });
        await syncOwnedDirectory(pendingPath, { filesystem });
        moved = await observeRegularFile(trash);
      } catch {
        await restoreUnexpectedMovedNode(trash, target);
        refuse("DOTAIOS_SESSION_STORE_POISONED");
      }
      if (!matchesCanonicalBefore(moved, manifest)) {
        await restoreUnexpectedMovedNode(trash, target);
        refuse("DOTAIOS_SESSION_STORE_POISONED");
      }
      await privatizeParkedFile(trash, moved);
      await fireFault("after_canonical_move", { kind: manifest.kind });
    } else if (!(current === null && matchesParkedCanonicalBefore(trashObservation, manifest))) {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    await fireFault("after_canonical", { kind: manifest.kind });
    await completeProjection(manifest);
  }

  async function completeProjection(manifest) {
    const current = await observeRegularFile(indexPath, { missing: true });
    if (current?.hash === manifest.projection_after) return;
    const previous = path.join(pendingPath, "previous-index.jsonl");
    const previousObservation = await prepareParkedProjection(previous, manifest, { missing: true });
    if (matchesProjectionBefore(current, manifest)) {
      if (manifest.projection_before !== null) {
        if (previousObservation === null) {
          const moveSnapshots = await snapshotMoveNamespaces(indexPath, previous);
          await filesystem.rename(indexPath, previous);
          let moved;
          try {
            await assertMoveNamespacesUnchanged(moveSnapshots);
            await syncOwnedDirectory(path.dirname(indexPath), { filesystem });
            await syncOwnedDirectory(pendingPath, { filesystem });
            moved = await observeRegularFile(previous);
          } catch {
            await restoreUnexpectedMovedNode(previous, indexPath);
            refuse("DOTAIOS_SESSION_STORE_POISONED");
          }
          if (!matchesProjectionBefore(moved, manifest)) {
            await restoreUnexpectedMovedNode(previous, indexPath);
            refuse("DOTAIOS_SESSION_STORE_POISONED");
          }
          await privatizeParkedFile(previous, moved);
          await fireFault("after_projection_move", { kind: manifest.kind });
        } else if (!matchesParkedProjectionBefore(previousObservation, manifest)) {
          refuse("DOTAIOS_SESSION_STORE_POISONED");
        }
      }
    } else if (!(current === null && matchesParkedProjectionBefore(previousObservation, manifest))) {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    await ensureCanonicalParents(indexPath, { kind: manifest.kind });
    const staged = path.join(pendingPath, "index.jsonl");
    await installStagedFile(staged, indexPath, manifest.projection_after);
    await fireFault("after_projection", { kind: manifest.kind });
  }

  async function recoverPending(checkDeadline) {
    if (!await hasPendingTransaction()) return;
    checkDeadline();
    await completePending(checkDeadline);
  }

  async function readManifest() {
    let stats;
    let namespaceSnapshot;
    try {
      namespaceSnapshot = await snapshotOperationalDirectory(pendingPath);
      stats = await filesystem.lstat(pendingPath);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink() || (process.platform !== "win32" && ((stats.mode & 0o777) !== 0o700 || stats.uid !== process.getuid()))) {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    await assertOperationalDirectorySnapshot(pendingPath, namespaceSnapshot);
    const manifestPath = path.join(pendingPath, "manifest.json");
    return readTransactionManifest(manifestPath);
  }

  async function cleanupPending(manifest, checkDeadline = () => {}) {
    const validation = await validateClosedTransaction(pendingPath, manifest);
    checkDeadline();
    const detached = path.join(storeRoot, `.cleanup-${manifest.id}`);
    await renameOperationalDirectory(
      pendingPath,
      detached,
      validation.directoryIdentity,
      { destinationMissing: true },
    );
    checkDeadline();
    await fireFault("after_cleanup_detach", { kind: manifest.kind });
    await purgeClosedTransaction(detached, manifest, checkDeadline, validation);
  }

  async function cleanupClosedTransactions(checkDeadline) {
    const entries = await readOperationalEntries();
    for (const entry of entries) {
      checkDeadline();
      if (!entry.name.startsWith(".cleanup-")) continue;
      const id = entry.name.slice(".cleanup-".length);
      if (!/^[0-9a-f-]{16,64}$/i.test(id) || !entry.isDirectory() || entry.isSymbolicLink()) {
        refuse("DOTAIOS_SESSION_STORE_POISONED");
      }
      const detached = path.join(storeRoot, entry.name);
      const manifest = await readTransactionManifest(path.join(detached, "manifest.json"), id);
      await purgeClosedTransaction(detached, manifest, checkDeadline);
    }
  }

  async function purgeClosedTransaction(transactionPath, manifest, checkDeadline = () => {}, priorValidation = null) {
    const validation = await validateClosedTransaction(transactionPath, manifest);
    if (
      priorValidation
      && !sameFileIdentityValue(validation.directoryIdentity, priorValidation.directoryIdentity)
    ) refuse("DOTAIOS_SESSION_STORE_POISONED");
    for (const [name, expected] of validation.observations) {
      checkDeadline();
      await detachAndPurgeOwnedChild(transactionPath, name, expected);
    }
    const finalDirectory = await filesystem.lstat(transactionPath);
    assertOwnedTransactionDirectory(finalDirectory);
    if (!sameFileIdentityValue(fileIdentity(finalDirectory), validation.directoryIdentity)) {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    const parentSnapshot = await snapshotOperationalRoot();
    await filesystem.rmdir(transactionPath);
    await assertOperationalRootSnapshot(parentSnapshot);
    await syncOwnedDirectory(storeRoot, { filesystem });
  }

  async function validateClosedTransaction(transactionPath, manifest) {
    const namespaceBefore = await snapshotOperationalDirectory(transactionPath);
    const directoryBefore = await filesystem.lstat(transactionPath);
    assertOwnedTransactionDirectory(directoryBefore);
    const expected = new Set(["manifest.json"]);
    if (manifest.kind === "grow") expected.add("previous.md");
    if (manifest.kind === "delete") expected.add("deleted.md");
    if (manifest.projection_before !== null) expected.add("previous-index.jsonl");
    const entries = await readDirectoryEntriesBounded(transactionPath, MAX_TRANSACTION_CHILD_ENTRIES);
    await assertOperationalDirectorySnapshot(transactionPath, namespaceBefore);
    if (entries.length !== expected.size) refuse("DOTAIOS_SESSION_STORE_POISONED");
    const observations = new Map();
    for (const entry of entries) {
      if (!expected.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
        refuse("DOTAIOS_SESSION_STORE_POISONED");
      }
      const observation = await observeRegularFile(path.join(transactionPath, entry.name), { owned: true });
      observations.set(entry.name, Object.freeze({
        identity: observation.identity,
        hash: observation.hash,
      }));
    }
    const directoryAfter = await filesystem.lstat(transactionPath);
    if (!sameFileIdentity(directoryBefore, directoryAfter)) refuse("DOTAIOS_SESSION_STORE_POISONED");
    if (await hashRegularFile(indexPath, { missing: true }) !== manifest.projection_after) {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    if (
      manifest.projection_before !== null
      && !matchesParkedProjectionBefore(
        await observeRegularFile(path.join(transactionPath, "previous-index.jsonl"), { owned: true }),
        manifest,
      )
    ) refuse("DOTAIOS_SESSION_STORE_POISONED");
    if (manifest.kind === "delete") {
      if (
        await hashRegularFile(canonicalTarget(manifest.target), { missing: true }) !== null
        || !matchesParkedCanonicalBefore(
          await observeRegularFile(path.join(transactionPath, "deleted.md"), { owned: true }),
          manifest,
        )
      ) refuse("DOTAIOS_SESSION_STORE_POISONED");
    } else if (manifest.kind === "grow") {
      if (
        await hashRegularFile(canonicalTarget(manifest.target), { missing: true }) !== manifest.canonical_after
        || !matchesParkedCanonicalBefore(
          await observeRegularFile(path.join(transactionPath, "previous.md"), { owned: true }),
          manifest,
        )
      ) refuse("DOTAIOS_SESSION_STORE_POISONED");
    } else if (manifest.kind !== "reconcile") {
      if (await hashRegularFile(canonicalTarget(manifest.target), { missing: true }) !== manifest.canonical_after) {
        refuse("DOTAIOS_SESSION_STORE_POISONED");
      }
    }
    return Object.freeze({
      directoryIdentity: fileIdentity(directoryAfter),
      observations,
    });
  }

  function assertOwnedTransactionDirectory(stats) {
    if (
      !stats.isDirectory()
      || stats.isSymbolicLink()
      || (
        process.platform !== "win32"
        && (stats.uid !== process.getuid() || (stats.mode & 0o777) !== 0o700)
      )
    ) refuse("DOTAIOS_SESSION_STORE_POISONED");
  }

  async function cleanupBootstrappingTransactions(checkDeadline) {
    const entries = await readOperationalEntries();
    for (const entry of entries) {
      checkDeadline();
      if (!entry.name.startsWith(".bootstrap-")) continue;
      const id = entry.name.slice(".bootstrap-".length);
      if (!/^[0-9a-f-]{16,64}$/i.test(id) || !entry.isDirectory() || entry.isSymbolicLink()) {
        refuse("DOTAIOS_SESSION_STORE_POISONED");
      }
      const bootstrapPath = path.join(storeRoot, entry.name);
      const validation = await validateBootstrapTransaction(bootstrapPath);
      const detached = path.join(storeRoot, `.discard-bootstrap-${id}-${crypto.randomUUID()}`);
      await renameOperationalDirectory(
        bootstrapPath,
        detached,
        validation.directoryIdentity,
        { destinationMissing: true },
      );
      await purgeBootstrapTransaction(detached, validation, checkDeadline);
    }
  }

  async function cleanupDiscardedBootstraps(checkDeadline) {
    const entries = await readOperationalEntries();
    for (const entry of entries) {
      checkDeadline();
      if (!entry.name.startsWith(".discard-bootstrap-")) continue;
      const match = entry.name.match(/^\.discard-bootstrap-([0-9a-f-]{16,64})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
      if (!match || !entry.isDirectory() || entry.isSymbolicLink()) {
        refuse("DOTAIOS_SESSION_STORE_POISONED");
      }
      const detached = path.join(storeRoot, entry.name);
      const validation = await validateBootstrapTransaction(detached);
      await purgeBootstrapTransaction(detached, validation, checkDeadline);
    }
  }

  async function validateBootstrapTransaction(transactionPath) {
    const namespaceBefore = await snapshotOperationalDirectory(transactionPath);
    const directoryBefore = await filesystem.lstat(transactionPath);
    assertOwnedTransactionDirectory(directoryBefore);
    const entries = await readDirectoryEntriesBounded(transactionPath, MAX_TRANSACTION_CHILD_ENTRIES);
    await assertOperationalDirectorySnapshot(transactionPath, namespaceBefore);
    if (entries.length > 3) refuse("DOTAIOS_SESSION_STORE_POISONED");
    const allowed = new Set(["manifest.json", "canonical.md", "index.jsonl"]);
    const observations = new Map();
    for (const entry of entries) {
      if (!allowed.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
        refuse("DOTAIOS_SESSION_STORE_POISONED");
      }
      const observation = await observeRegularFile(path.join(transactionPath, entry.name), { owned: true });
      observations.set(entry.name, Object.freeze({
        identity: observation.identity,
        hash: observation.hash,
      }));
    }
    const directoryAfter = await filesystem.lstat(transactionPath);
    if (!sameFileIdentity(directoryBefore, directoryAfter)) refuse("DOTAIOS_SESSION_STORE_POISONED");
    return Object.freeze({
      directoryIdentity: fileIdentity(directoryAfter),
      observations,
    });
  }

  async function purgeBootstrapTransaction(transactionPath, priorValidation, checkDeadline = () => {}) {
    const validation = await validateBootstrapTransaction(transactionPath);
    if (!sameFileIdentityValue(validation.directoryIdentity, priorValidation.directoryIdentity)) {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    for (const [name, prior] of priorValidation.observations) {
      const current = validation.observations.get(name);
      if (!current || current.hash !== prior.hash || !sameFileIdentityValue(current.identity, prior.identity)) {
        refuse("DOTAIOS_SESSION_STORE_POISONED");
      }
    }
    for (const [name, expected] of validation.observations) {
      checkDeadline();
      await detachAndPurgeOwnedChild(transactionPath, name, expected);
    }
    const finalDirectory = await filesystem.lstat(transactionPath);
    if (!sameFileIdentityValue(fileIdentity(finalDirectory), validation.directoryIdentity)) {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    const parentSnapshot = await snapshotOperationalRoot();
    await filesystem.rmdir(transactionPath);
    await assertOperationalRootSnapshot(parentSnapshot);
    await syncOwnedDirectory(storeRoot, { filesystem });
  }

  async function cleanupUnpublishedTransactions(checkDeadline) {
    const entries = await readOperationalEntries();
    for (const entry of entries) {
      checkDeadline();
      if (!entry.name.startsWith(".private-")) continue;
      const id = entry.name.slice(".private-".length);
      if (!/^[0-9a-f-]{16,64}$/i.test(id) || !entry.isDirectory() || entry.isSymbolicLink()) {
        refuse("DOTAIOS_SESSION_STORE_POISONED");
      }
      const privatePath = path.join(storeRoot, entry.name);
      const validation = await validateUnpublishedTransaction(privatePath, id);
      const detached = path.join(storeRoot, `.discard-${id}-${crypto.randomUUID()}`);
      await renameOperationalDirectory(
        privatePath,
        detached,
        validation.directoryIdentity,
        { destinationMissing: true },
      );
      await purgeUnpublishedTransaction(detached, validation, checkDeadline);
    }
  }

  async function cleanupDiscardedTransactions(checkDeadline) {
    const entries = await readOperationalEntries();
    for (const entry of entries) {
      checkDeadline();
      if (!entry.name.startsWith(".discard-")) continue;
      const match = entry.name.match(/^\.discard-([0-9a-f-]{16,64})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
      if (!match || !entry.isDirectory() || entry.isSymbolicLink()) {
        refuse("DOTAIOS_SESSION_STORE_POISONED");
      }
      const detached = path.join(storeRoot, entry.name);
      const validation = await validateUnpublishedTransaction(detached, match[1]);
      await purgeUnpublishedTransaction(detached, validation, checkDeadline);
    }
  }

  async function validateUnpublishedTransaction(transactionPath, expectedId) {
    const namespaceBefore = await snapshotOperationalDirectory(transactionPath);
    const directoryBefore = await filesystem.lstat(transactionPath);
    assertOwnedTransactionDirectory(directoryBefore);
    const manifest = await readTransactionManifest(path.join(transactionPath, "manifest.json"), expectedId);
    const expected = new Set([
      "manifest.json",
      "index.jsonl",
      ...(manifest.canonical_after === null ? [] : ["canonical.md"]),
    ]);
    const entries = await readDirectoryEntriesBounded(transactionPath, MAX_TRANSACTION_CHILD_ENTRIES);
    await assertOperationalDirectorySnapshot(transactionPath, namespaceBefore);
    if (entries.length !== expected.size) refuse("DOTAIOS_SESSION_STORE_POISONED");
    const observations = new Map();
    for (const entry of entries) {
      if (!expected.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
        refuse("DOTAIOS_SESSION_STORE_POISONED");
      }
      const observation = await observeRegularFile(path.join(transactionPath, entry.name), { owned: true });
      observations.set(entry.name, Object.freeze({
        identity: observation.identity,
        hash: observation.hash,
      }));
    }
    if (observations.get("index.jsonl").hash !== manifest.projection_after) {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    if (
      manifest.canonical_after !== null
      && observations.get("canonical.md").hash !== manifest.canonical_after
    ) refuse("DOTAIOS_SESSION_STORE_POISONED");
    const directoryAfter = await filesystem.lstat(transactionPath);
    if (!sameFileIdentity(directoryBefore, directoryAfter)) refuse("DOTAIOS_SESSION_STORE_POISONED");
    return Object.freeze({
      directoryIdentity: fileIdentity(directoryAfter),
      expectedId,
      observations,
    });
  }

  async function purgeUnpublishedTransaction(transactionPath, priorValidation, checkDeadline = () => {}) {
    const validation = await validateUnpublishedTransaction(transactionPath, priorValidation.expectedId);
    if (!sameFileIdentityValue(validation.directoryIdentity, priorValidation.directoryIdentity)) {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    for (const [name, prior] of priorValidation.observations) {
      const current = validation.observations.get(name);
      if (!current || current.hash !== prior.hash || !sameFileIdentityValue(current.identity, prior.identity)) {
        refuse("DOTAIOS_SESSION_STORE_POISONED");
      }
    }
    for (const [name, prior] of validation.observations) {
      checkDeadline();
      await detachAndPurgeOwnedChild(transactionPath, name, prior);
    }
    const finalDirectory = await filesystem.lstat(transactionPath);
    if (!sameFileIdentityValue(fileIdentity(finalDirectory), validation.directoryIdentity)) {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    const parentSnapshot = await snapshotOperationalRoot();
    await filesystem.rmdir(transactionPath);
    await assertOperationalRootSnapshot(parentSnapshot);
    await syncOwnedDirectory(storeRoot, { filesystem });
  }

  async function detachAndPurgeOwnedChild(transactionPath, name, expected) {
    const transactionSnapshot = await snapshotOperationalDirectory(transactionPath);
    const childPath = path.join(transactionPath, name);
    const current = await observeRegularFile(childPath, { owned: true });
    if (
      current.hash !== expected.hash
      || !sameFileIdentityValue(current.identity, expected.identity)
    ) refuse("DOTAIOS_SESSION_STORE_POISONED");
    const detached = path.join(transactionPath, `.purge-${crypto.randomUUID()}`);
    await filesystem.rename(childPath, detached);
    await assertOperationalDirectorySnapshot(transactionPath, transactionSnapshot);
    await syncOwnedDirectory(transactionPath, { filesystem });
    let moved;
    try {
      moved = await observeRegularFile(detached, { owned: true });
    } catch {
      await restoreUnexpectedMovedNode(detached, childPath);
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    if (
      moved.hash !== expected.hash
      || !sameFileIdentityValue(moved.identity, expected.identity)
    ) {
      await restoreUnexpectedMovedNode(detached, childPath);
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    const final = await observeRegularFile(detached, { owned: true });
    if (
      final.hash !== expected.hash
      || !sameFileIdentityValue(final.identity, expected.identity)
    ) refuse("DOTAIOS_SESSION_STORE_POISONED");
    const finalTransactionSnapshot = await snapshotOperationalDirectory(transactionPath);
    await filesystem.unlink(detached);
    await assertOperationalDirectorySnapshot(transactionPath, finalTransactionSnapshot);
    await syncOwnedDirectory(transactionPath, { filesystem });
  }

  async function readTransactionManifest(manifestPath, expectedId = null) {
    let raw;
    try {
      raw = await readOwned(manifestPath);
    } catch (error) {
      if (error?.code === "DOTAIOS_SESSION_STORE_POISONED") throw error;
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    let manifest;
    try { manifest = JSON.parse(raw); } catch { refuse("DOTAIOS_SESSION_STORE_POISONED"); }
    const allowed = [
      "format", "id", "kind", "target", "canonical_before", "canonical_identity_before",
      "canonical_after", "projection_before", "projection_identity_before", "projection_after",
    ];
    const exactKeys = manifest
      && Object.keys(manifest).length === allowed.length
      && Object.keys(manifest).every((key) => allowed.includes(key));
    const hashOrNull = (value) => value === null || /^[0-9a-f]{64}$/.test(value);
    const validHash = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
    if (
      !exactKeys
      || manifest.format !== TRANSACTION_FORMAT
      || !/^[0-9a-f-]{16,64}$/i.test(manifest.id)
      || (expectedId !== null && manifest.id !== expectedId)
      || !["create", "grow", "conflict", "reconcile", "delete"].includes(manifest.kind)
      || !hashOrNull(manifest.canonical_before)
      || !(manifest.canonical_identity_before === null || validFileIdentity(manifest.canonical_identity_before))
      || !hashOrNull(manifest.canonical_after)
      || !hashOrNull(manifest.projection_before)
      || !(manifest.projection_identity_before === null || validFileIdentity(manifest.projection_identity_before))
      || !validHash(manifest.projection_after)
    ) refuse("DOTAIOS_SESSION_STORE_POISONED");
    if (
      (manifest.projection_before === null) !== (manifest.projection_identity_before === null)
    ) refuse("DOTAIOS_SESSION_STORE_POISONED");
    if (manifest.kind === "reconcile") {
      if (
        manifest.target !== null
        || manifest.canonical_before !== null
        || manifest.canonical_identity_before !== null
        || manifest.canonical_after !== null
      ) {
        refuse("DOTAIOS_SESSION_STORE_POISONED");
      }
    } else {
      if (typeof manifest.target !== "string") refuse("DOTAIOS_SESSION_STORE_POISONED");
      canonicalTarget(manifest.target);
      if (manifest.kind === "delete") {
        if (
          !validHash(manifest.canonical_before)
          || !validFileIdentity(manifest.canonical_identity_before)
          || manifest.canonical_after !== null
        ) {
          refuse("DOTAIOS_SESSION_STORE_POISONED");
        }
      } else if (manifest.kind === "grow") {
        if (
          !validHash(manifest.canonical_before)
          || !validFileIdentity(manifest.canonical_identity_before)
          || !validHash(manifest.canonical_after)
        ) {
          refuse("DOTAIOS_SESSION_STORE_POISONED");
        }
      } else if (
        manifest.canonical_before !== null
        || manifest.canonical_identity_before !== null
        || !validHash(manifest.canonical_after)
      ) {
        refuse("DOTAIOS_SESSION_STORE_POISONED");
      }
    }
    return Object.freeze(manifest);
  }

  async function createOwnedTransactionDirectory(directoryPath) {
    const parentSnapshot = await snapshotOperationalRoot();
    try {
      await filesystem.mkdir(directoryPath, { mode: 0o700 });
    } catch {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    await assertOperationalRootSnapshot(parentSnapshot);
    const stats = await filesystem.lstat(directoryPath);
    assertOwnedTransactionDirectory(stats);
    await syncOwnedDirectory(storeRoot, { filesystem });
  }

  async function renameOperationalDirectory(source, destination, expectedIdentity, { destinationMissing = false } = {}) {
    const parentSnapshot = await snapshotOperationalRoot();
    const sourceSnapshot = await snapshotOperationalDirectory(source);
    const sourceStats = await filesystem.lstat(source);
    if (!sameFileIdentityValue(fileIdentity(sourceStats), expectedIdentity)) {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    if (destinationMissing && await operationalPathExists(destination)) {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    try {
      await filesystem.rename(source, destination);
    } catch {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    await assertOperationalRootSnapshot(parentSnapshot);
    const destinationSnapshot = await snapshotOperationalDirectory(destination);
    const destinationStats = await filesystem.lstat(destination);
    if (
      !sameFileIdentityValue(fileIdentity(destinationStats), expectedIdentity)
      || !sameDirectoryNamespaceIdentity(sourceSnapshot, destinationSnapshot)
    ) refuse("DOTAIOS_SESSION_STORE_POISONED");
    await syncOwnedDirectory(storeRoot, { filesystem });
  }

  async function operationalPathExists(candidate) {
    await assertOperationalRootUnchanged();
    try {
      await filesystem.lstat(candidate);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  async function readOperationalEntries() {
    const rootSnapshot = await snapshotOperationalRoot();
    const entries = await readDirectoryEntriesBounded(storeRoot, MAX_OPERATIONAL_ENTRIES);
    await assertOperationalRootSnapshot(rootSnapshot);
    return entries;
  }

  async function readDirectoryEntriesBounded(directoryPath, maximumEntries) {
    if (typeof filesystem.opendir !== "function") refuse("DOTAIOS_SESSION_STORE_POISONED");
    const directory = await filesystem.opendir(directoryPath);
    const entries = [];
    try {
      while (true) {
        const entry = await directory.read();
        if (!entry) break;
        entries.push(entry);
        if (entries.length > maximumEntries) refuse("DOTAIOS_SESSION_STORE_POISONED");
      }
    } finally {
      await directory.close().catch((error) => {
        if (error?.code !== "ERR_DIR_CLOSED") throw error;
      });
    }
    return entries;
  }

  async function snapshotOperationalRoot({ comparePrepared = true } = {}) {
    let parentBefore;
    let rootBefore;
    let parentAfter;
    let rootAfter;
    try {
      parentBefore = await inspectContainedDirectory(aiosPath, dotaiosRoot, {
        filesystem,
        returnSnapshot: true,
      });
      rootBefore = await filesystem.lstat(storeRoot);
      parentAfter = await inspectContainedDirectory(aiosPath, dotaiosRoot, {
        filesystem,
        returnSnapshot: true,
      });
      rootAfter = await filesystem.lstat(storeRoot);
    } catch {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    assertOwnedTransactionDirectory(rootBefore);
    assertOwnedTransactionDirectory(rootAfter);
    if (
      !parentBefore
      || !parentAfter
      || !sameDirectoryNamespaceIdentity(parentBefore, parentAfter)
      || !sameFileIdentityValue(fileIdentity(rootBefore), fileIdentity(rootAfter))
    ) refuse("DOTAIOS_SESSION_STORE_POISONED");
    const snapshot = Object.freeze({
      stats: rootAfter,
      ancestors: Object.freeze([
        ...parentAfter.ancestors,
        Object.freeze({
          path: dotaiosRoot,
          stats: parentAfter.stats,
          resolvedPath: dotaiosRoot,
          resolvedStats: parentAfter.stats,
        }),
      ]),
    });
    if (!snapshot) refuse("DOTAIOS_SESSION_STORE_POISONED");
    if (
      comparePrepared
      && operationalRootSnapshot
      && !sameDirectoryNamespaceIdentity(operationalRootSnapshot, snapshot)
    ) refuse("DOTAIOS_SESSION_STORE_POISONED");
    return snapshot;
  }

  async function assertOperationalRootUnchanged() {
    if (!operationalRootSnapshot) refuse("DOTAIOS_SESSION_STORE_POISONED");
    await assertOperationalRootSnapshot(operationalRootSnapshot);
  }

  async function assertOperationalRootSnapshot(expected) {
    const actual = await snapshotOperationalRoot({ comparePrepared: false });
    if (!sameDirectoryNamespaceIdentity(expected, actual)) {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    if (
      operationalRootSnapshot
      && !sameDirectoryNamespaceIdentity(operationalRootSnapshot, actual)
    ) refuse("DOTAIOS_SESSION_STORE_POISONED");
  }

  async function snapshotOperationalDirectory(directoryPath) {
    await assertOperationalRootUnchanged();
    if (!isPathWithinLexically(storeRoot, directoryPath)) refuse("DOTAIOS_SESSION_STORE_POISONED");
    const relative = path.relative(storeRoot, directoryPath);
    const paths = [storeRoot];
    for (const component of relative.split(path.sep).filter(Boolean)) {
      paths.push(path.join(paths.at(-1), component));
    }
    const before = [];
    for (const candidate of paths) {
      let stats;
      try { stats = await filesystem.lstat(candidate); } catch { refuse("DOTAIOS_SESSION_STORE_POISONED"); }
      assertOwnedTransactionDirectory(stats);
      before.push(Object.freeze({ path: candidate, stats }));
    }
    await assertOperationalRootUnchanged();
    const after = [];
    for (const candidate of paths) {
      let stats;
      try { stats = await filesystem.lstat(candidate); } catch { refuse("DOTAIOS_SESSION_STORE_POISONED"); }
      assertOwnedTransactionDirectory(stats);
      after.push(Object.freeze({ path: candidate, stats }));
    }
    if (before.some((entry, index) => (
      !sameFileIdentityValue(fileIdentity(entry.stats), fileIdentity(after[index].stats))
    ))) refuse("DOTAIOS_SESSION_STORE_POISONED");
    await assertOperationalRootUnchanged();
    return Object.freeze({
      stats: after.at(-1).stats,
      ancestors: Object.freeze(after.slice(0, -1).map((entry) => Object.freeze({
        path: entry.path,
        stats: entry.stats,
        resolvedPath: entry.path,
        resolvedStats: entry.stats,
      }))),
    });
  }

  async function assertOperationalDirectorySnapshot(directoryPath, expected) {
    const actual = await snapshotOperationalDirectory(directoryPath);
    if (!sameDirectoryNamespaceIdentity(expected, actual)) {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
  }

  async function snapshotPublicationDirectory(directoryPath) {
    try {
      const snapshot = await inspectContainedDirectory(aiosPath, directoryPath, {
        filesystem,
        returnSnapshot: true,
      });
      if (!snapshot) refuse("DOTAIOS_SESSION_STORE_POISONED");
      return snapshot;
    } catch (error) {
      if (error?.code === "DOTAIOS_SESSION_STORE_POISONED") throw error;
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
  }

  async function assertPublicationDirectoryUnchanged(directoryPath, expected) {
    const actual = await snapshotPublicationDirectory(directoryPath);
    if (!sameDirectoryNamespaceIdentity(expected, actual)) {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
  }

  async function prepareOperationalRoot() {
    await assertDirectoryOrCreate(aiosPath, { create: false, shared: true });
    await assertDirectoryOrCreate(dotaiosRoot, { create: true, shared: true });
    await ensureOwnedDirectory(storeRoot, { filesystem });
    operationalRootSnapshot = await snapshotOperationalRoot({ comparePrepared: false });
  }

  async function inspectOperationalState() {
    try {
      const aios = await inspectContainedDirectory(aiosPath, aiosPath, {
        filesystem,
        returnSnapshot: true,
      });
      if (!aios) return Object.freeze({ status: "unsafe" });
      let dotaios;
      try { dotaios = await filesystem.lstat(dotaiosRoot); } catch (error) {
        if (error?.code === "ENOENT") return Object.freeze({ status: "clean" });
        throw error;
      }
      if (!isSafeOperationalDirectory(dotaios, { shared: true })) {
        return Object.freeze({ status: "unsafe" });
      }
      let store;
      try { store = await filesystem.lstat(storeRoot); } catch (error) {
        if (error?.code === "ENOENT") return Object.freeze({ status: "clean" });
        throw error;
      }
      if (!isSafeOperationalDirectory(store)) return Object.freeze({ status: "unsafe" });
      const rootSnapshot = await inspectContainedDirectory(aiosPath, storeRoot, {
        filesystem,
        returnSnapshot: true,
      });
      if (!rootSnapshot) return Object.freeze({ status: "unsafe" });
      const entries = await readDirectoryEntriesBounded(storeRoot, MAX_OPERATIONAL_ENTRIES);
      let pending = false;
      for (const entry of entries) {
        const expectedType = operationalEntryType(entry.name);
        if (!expectedType) return Object.freeze({ status: "poisoned" });
        const entryPath = path.join(storeRoot, entry.name);
        const before = await filesystem.lstat(entryPath);
        const safe = expectedType === "directory"
          ? isSafeOperationalDirectory(before)
          : isSafeOperationalFile(before);
        if (!safe) return Object.freeze({ status: "unsafe" });
        const after = await filesystem.lstat(entryPath);
        if (!sameFileIdentity(before, after)) return Object.freeze({ status: "unsafe" });
        pending = true;
      }
      const confirmed = await inspectContainedDirectory(aiosPath, storeRoot, {
        filesystem,
        returnSnapshot: true,
      });
      if (!sameDirectoryNamespaceIdentity(rootSnapshot, confirmed)) {
        return Object.freeze({ status: "unsafe" });
      }
      return Object.freeze({ status: pending ? "pending" : "clean" });
    } catch {
      return Object.freeze({ status: "unsafe" });
    }
  }

  function isSafeOperationalDirectory(stats, { shared = false } = {}) {
    if (!stats?.isDirectory() || stats.isSymbolicLink()) return false;
    if (process.platform === "win32") return true;
    const permissions = stats.mode & 0o777;
    return stats.uid === process.getuid()
      && (shared ? (permissions & 0o022) === 0 : permissions === 0o700);
  }

  function isSafeOperationalFile(stats) {
    if (!stats?.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) return false;
    if (process.platform === "win32") return true;
    return stats.uid === process.getuid() && (stats.mode & 0o777) === 0o600;
  }

  function operationalEntryType(name) {
    const lockBase = "store\\.lock(?:\\.recovery)*";
    if (
      new RegExp(
        `^${lockBase}(?:\\.transition|\\.(?:release|stale)\\.${OPERATION_LOCK_UUID_PATTERN})?$`,
        "i",
      ).test(name)
      || new RegExp(
        `^\\.${lockBase}(?:\\.transition)?\\.${OPERATION_LOCK_UUID_PATTERN}\\.tmp$`,
        "i",
      ).test(name)
    ) return "file";
    if (
      name === "pending"
      || /^\.(?:bootstrap|private|cleanup)-[0-9a-f-]{16,64}$/i.test(name)
      || /^\.discard-[0-9a-f-]{16,64}-[0-9a-f-]{36}$/i.test(name)
      || /^\.discard-bootstrap-[0-9a-f-]{16,64}-[0-9a-f-]{36}$/i.test(name)
    ) return "directory";
    return null;
  }

  async function assertDirectoryOrCreate(directory, { create, shared }) {
    let stats;
    try { stats = await filesystem.lstat(directory); } catch (error) {
      if (error?.code !== "ENOENT" || !create) throw error;
      await filesystem.mkdir(directory, { mode: 0o700 }).catch((mkdirError) => {
        if (mkdirError?.code !== "EEXIST") throw mkdirError;
      });
      stats = await filesystem.lstat(directory);
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) refuse("DOTAIOS_SESSION_OPERATIONAL_PATH_UNSAFE");
    if (process.platform !== "win32") {
      const permissions = stats.mode & 0o777;
      if (stats.uid !== process.getuid() || (shared ? (permissions & 0o022) !== 0 : permissions !== 0o700)) {
        refuse("DOTAIOS_SESSION_OPERATIONAL_PATH_UNSAFE");
      }
    }
  }

  async function ensureCanonicalParents(target, { kind = "reconcile" } = {}) {
    const relative = path.relative(aiosPath, path.dirname(target));
    let current = aiosPath;
    for (const component of relative.split(path.sep).filter(Boolean)) {
      const parent = current;
      current = path.join(current, component);
      let stats;
      let created = false;
      try { stats = await filesystem.lstat(current); } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        const parentSnapshot = await snapshotPublicationDirectory(parent);
        await filesystem.mkdir(current, { mode: 0o700 }).catch((mkdirError) => {
          if (mkdirError?.code !== "EEXIST") throw mkdirError;
        });
        await assertPublicationDirectoryUnchanged(parent, parentSnapshot);
        stats = await filesystem.lstat(current);
        await syncOwnedDirectory(parent, { filesystem });
        created = true;
      }
      if (!stats.isDirectory() || stats.isSymbolicLink()) refuse("DOTAIOS_SESSION_CANONICAL_UNSAFE");
      if (process.platform !== "win32" && stats.uid !== process.getuid()) refuse("DOTAIOS_SESSION_CANONICAL_UNSAFE");
      await snapshotPublicationDirectory(current);
      if (created && current === sessionsRoot) {
        await fireFault("after_sessions_root_creation", { kind });
      }
      if (created && current === path.dirname(target) && current !== sessionsRoot) {
        await fireFault("after_session_date_creation", { kind });
      }
    }
  }

  function canonicalTarget(relativePath) {
    if (
      !parseSessionRelativePath(relativePath, { requireCanonicalFilename: true })
      || path.isAbsolute(relativePath)
    ) refuse("DOTAIOS_SESSION_STORE_POISONED");
    const target = path.resolve(aiosPath, relativePath);
    if (!isPathWithinLexically(sessionsRoot, target) || target === indexPath) refuse("DOTAIOS_SESSION_STORE_POISONED");
    return target;
  }

  async function writeOwned(filePath, bytes) {
    const handle = await filesystem.open(filePath, "wx", 0o600);
    try {
      await handle.writeFile(bytes, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    assertOwnedFileStats(await filesystem.lstat(filePath));
    await syncOwnedDirectory(path.dirname(filePath), { filesystem });
  }

  async function writeBootstrapManifest(filePath, bytes, context) {
    const buffer = Buffer.from(bytes, "utf8");
    const split = Math.max(1, Math.floor(buffer.length / 2));
    const handle = await filesystem.open(filePath, "wx", 0o600);
    try {
      await handle.write(buffer.subarray(0, split), 0, split, 0);
      await handle.sync();
      await fireFault("during_bootstrap_manifest", context);
      await handle.write(buffer.subarray(split), 0, buffer.length - split, split);
      await handle.sync();
    } finally {
      await handle.close();
    }
    assertOwnedFileStats(await filesystem.lstat(filePath));
    await syncOwnedDirectory(path.dirname(filePath), { filesystem });
  }

  async function readOwned(filePath) {
    const parentSnapshot = await snapshotFileParent(filePath);
    const before = await filesystem.lstat(filePath);
    assertOwnedFileStats(before);
    if (before.size > MAX_MANIFEST_BYTES) refuse("DOTAIOS_SESSION_STORE_POISONED");
    const handle = await filesystem.open(filePath, READ_NOFOLLOW_FLAGS);
    try {
      const opened = await handle.stat();
      assertOwnedFileStats(opened);
      if (!sameFileContentSnapshot(before, opened) || opened.size > MAX_MANIFEST_BYTES) {
        refuse("DOTAIOS_SESSION_STORE_POISONED");
      }
      const bytes = await readHandleBounded(handle, MAX_MANIFEST_BYTES);
      const openedAfter = await handle.stat();
      const after = await filesystem.lstat(filePath);
      if (
        !sameFileContentSnapshot(opened, openedAfter)
        || !sameFileContentSnapshot(openedAfter, after)
      ) refuse("DOTAIOS_SESSION_STORE_POISONED");
      await assertFileParentUnchanged(filePath, parentSnapshot);
      try { return strictDecodeUtf8(bytes); } catch { refuse("DOTAIOS_SESSION_STORE_POISONED"); }
    } finally {
      await handle.close();
    }
  }

  async function observeRegularFile(filePath, { missing = false, owned = false } = {}) {
    const parentSnapshot = await snapshotFileParent(filePath);
    let stats;
    try { stats = await filesystem.lstat(filePath); } catch (error) {
      if (missing && error?.code === "ENOENT") {
        await assertFileParentUnchanged(filePath, parentSnapshot);
        return null;
      }
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink() || (process.platform !== "win32" && stats.nlink !== 1)) {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    if (stats.size > MAX_TRANSACTION_ARTIFACT_BYTES) refuse("DOTAIOS_SESSION_STORE_POISONED");
    if (owned) assertOwnedFileStats(stats);
    const handle = await filesystem.open(filePath, READ_NOFOLLOW_FLAGS);
    try {
      const opened = await handle.stat();
      if (
        !sameFileContentSnapshot(stats, opened)
        || opened.size > MAX_TRANSACTION_ARTIFACT_BYTES
      ) refuse("DOTAIOS_SESSION_STORE_POISONED");
      const bytes = await readHandleBounded(handle, MAX_TRANSACTION_ARTIFACT_BYTES);
      const openedAfter = await handle.stat();
      const after = await filesystem.lstat(filePath);
      if (
        !sameFileContentSnapshot(opened, openedAfter)
        || !sameFileContentSnapshot(openedAfter, after)
      ) refuse("DOTAIOS_SESSION_STORE_POISONED");
      await assertFileParentUnchanged(filePath, parentSnapshot);
      return Object.freeze({ hash: sha256(bytes), identity: fileIdentity(after) });
    } finally { await handle.close(); }
  }

  async function readHandleBounded(handle, maxBytes) {
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) refuse("DOTAIOS_SESSION_STORE_POISONED");
    return bytes.subarray(0, offset);
  }

  function sameFileContentSnapshot(left, right) {
    return sameFileIdentity(left, right)
      && left.size === right.size
      && left.mtimeMs === right.mtimeMs
      && left.ctimeMs === right.ctimeMs;
  }

  async function hashRegularFile(filePath, options = {}) {
    const observation = await observeRegularFile(filePath, options);
    return observation?.hash ?? null;
  }

  async function snapshotFileParent(filePath) {
    if (isPathWithinLexically(storeRoot, filePath)) {
      return snapshotOperationalDirectory(path.dirname(filePath));
    }
    return snapshotPublicationDirectory(path.dirname(filePath));
  }

  async function assertFileParentUnchanged(filePath, expected) {
    if (isPathWithinLexically(storeRoot, filePath)) {
      return assertOperationalDirectorySnapshot(path.dirname(filePath), expected);
    }
    await assertPublicationDirectoryUnchanged(path.dirname(filePath), expected);
  }

  async function snapshotMoveNamespaces(source, destination) {
    return Object.freeze({
      source,
      sourceParent: await snapshotFileParent(source),
      destination,
      destinationParent: await snapshotFileParent(destination),
    });
  }

  async function assertMoveNamespacesUnchanged(snapshots) {
    await assertFileParentUnchanged(snapshots.source, snapshots.sourceParent);
    await assertFileParentUnchanged(snapshots.destination, snapshots.destinationParent);
  }

  async function prepareParkedCanonical(filePath, manifest, { missing = false } = {}) {
    return prepareParkedFile(filePath, manifest, "canonical", { missing });
  }

  async function prepareParkedProjection(filePath, manifest, { missing = false } = {}) {
    return prepareParkedFile(filePath, manifest, "projection", { missing });
  }

  async function prepareParkedFile(filePath, manifest, field, { missing = false } = {}) {
    const observation = await observeRegularFile(filePath, { missing });
    if (observation === null) return null;
    if (matchesEvidenceBefore(observation, manifest, field, { parked: true })) {
      return observeRegularFile(filePath, { owned: true });
    }
    if (!matchesEvidenceBefore(observation, manifest, field)) refuse("DOTAIOS_SESSION_STORE_POISONED");
    return privatizeParkedFile(filePath, observation);
  }

  async function privatizeParkedFile(filePath, observation) {
    if (process.platform === "win32") return observation;
    const parentSnapshot = await snapshotFileParent(filePath);
    const before = await filesystem.lstat(filePath);
    if (!sameFileIdentityValue(fileIdentity(before), observation.identity)) {
      refuse("DOTAIOS_SESSION_STORE_POISONED");
    }
    const handle = await filesystem.open(filePath, READ_NOFOLLOW_FLAGS);
    try {
      const opened = await handle.stat();
      if (!sameFileIdentity(before, opened)) refuse("DOTAIOS_SESSION_STORE_POISONED");
      await handle.chmod(0o600);
      await handle.sync();
      const changed = await handle.stat();
      const canonical = await filesystem.lstat(filePath);
      if (
        !sameNodeExceptMode(opened, changed)
        || !sameFileIdentity(changed, canonical)
        || (changed.mode & 0o777) !== 0o600
      ) refuse("DOTAIOS_SESSION_STORE_POISONED");
    } finally {
      await handle.close();
    }
    await assertFileParentUnchanged(filePath, parentSnapshot);
    await syncOwnedDirectory(path.dirname(filePath), { filesystem });
    return observeRegularFile(filePath, { owned: true });
  }

  function matchesCanonicalBefore(observation, manifest) {
    return matchesEvidenceBefore(observation, manifest, "canonical");
  }

  function matchesProjectionBefore(observation, manifest) {
    return matchesEvidenceBefore(observation, manifest, "projection");
  }

  function matchesParkedCanonicalBefore(observation, manifest) {
    return matchesEvidenceBefore(observation, manifest, "canonical", { parked: true });
  }

  function matchesParkedProjectionBefore(observation, manifest) {
    return matchesEvidenceBefore(observation, manifest, "projection", { parked: true });
  }

  function matchesEvidenceBefore(observation, manifest, field, { parked = false } = {}) {
    const hash = manifest[`${field}_before`];
    const identity = manifest[`${field}_identity_before`];
    if (hash === null) return observation === null;
    return Boolean(
      observation
      && observation.hash === hash
      && (parked
        ? samePrivatizedFileIdentity(observation.identity, identity)
        : sameFileIdentityValue(observation.identity, identity))
    );
  }

  async function restoreUnexpectedMovedNode(movedPath, target) {
    let before;
    let namespaceSnapshots;
    try {
      namespaceSnapshots = await snapshotMoveNamespaces(movedPath, target);
      before = await filesystem.lstat(movedPath);
    } catch {
      return false;
    }
    if (!before.isFile() || before.isSymbolicLink() || (process.platform !== "win32" && before.nlink !== 1)) {
      return false;
    }
    try {
      await filesystem.link(movedPath, target);
      await assertMoveNamespacesUnchanged(namespaceSnapshots);
    } catch {
      return false;
    }
    try {
      const [moved, restored] = await Promise.all([
        filesystem.lstat(movedPath),
        filesystem.lstat(target),
      ]);
      if (
        !sameNodeIgnoringLinkCount(before, moved)
        || !sameNodeIgnoringLinkCount(moved, restored)
        || !moved.isFile()
        || !restored.isFile()
        || moved.isSymbolicLink()
        || restored.isSymbolicLink()
        || (process.platform !== "win32" && (moved.nlink !== 2 || restored.nlink !== 2))
      ) {
        return false;
      }
      await syncOwnedDirectory(path.dirname(target), { filesystem });
      await filesystem.unlink(movedPath);
      await syncOwnedDirectory(path.dirname(movedPath), { filesystem });
      await syncOwnedDirectory(path.dirname(target), { filesystem });
      const final = await filesystem.lstat(target);
      return sameNodeIgnoringLinkCount(restored, final)
        && final.isFile()
        && !final.isSymbolicLink()
        && (process.platform === "win32" || final.nlink === 1);
    } catch {
      // If restoration cannot be proved, leave every surviving name in place.
      return false;
    }
  }

  async function hasPendingTransaction() {
    await assertOperationalRootUnchanged();
    try {
      const stats = await filesystem.lstat(pendingPath);
      if (!stats.isDirectory() || stats.isSymbolicLink()) refuse("DOTAIOS_SESSION_STORE_POISONED");
      const snapshot = await snapshotOperationalDirectory(pendingPath);
      await assertOperationalDirectorySnapshot(pendingPath, snapshot);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") {
        await assertOperationalRootUnchanged();
        return false;
      }
      throw error;
    }
  }

  async function fireFault(phase, context) {
    await faultInjector(phase, Object.freeze({ ...context }));
  }
  return Object.freeze({
    hasPendingTransaction,
    inspectOperationalState,
    prepareOperationalRoot,
    prepareMutation,
    publishMutation,
  });
}
