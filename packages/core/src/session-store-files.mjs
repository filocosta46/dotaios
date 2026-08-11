export function fileIdentity(stats) {
  return Object.freeze({
    dev: String(stats.dev),
    ino: String(stats.ino),
    mode: Number(stats.mode),
    uid: Number(stats.uid),
  });
}

export function validFileIdentity(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 4
    && ["dev", "ino", "mode", "uid"].every((key) => Object.hasOwn(value, key))
    && /^\d+$/.test(value.dev)
    && /^\d+$/.test(value.ino)
    && Number.isSafeInteger(value.mode)
    && value.mode >= 0
    && Number.isSafeInteger(value.uid)
    && value.uid >= 0
  );
}

export function sameFileIdentityValue(left, right) {
  return validFileIdentity(left)
    && validFileIdentity(right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid;
}

export function sameOptionalFileIdentity(left, right) {
  return left === null && right === null
    ? true
    : sameFileIdentityValue(left, right);
}

export function samePrivatizedFileIdentity(left, original) {
  if (!validFileIdentity(left) || !validFileIdentity(original)) return false;
  const expectedMode = process.platform === "win32"
    ? original.mode
    : (original.mode & ~0o777) | 0o600;
  return left.dev === original.dev
    && left.ino === original.ino
    && left.uid === original.uid
    && left.mode === expectedMode;
}

export function sameDirectoryNamespaceIdentity(left, right) {
  if (!left || !right || !sameStatNodeIdentity(left.stats, right.stats)) return false;
  if (!Array.isArray(left.ancestors) || !Array.isArray(right.ancestors)) return false;
  if (left.ancestors.length !== right.ancestors.length) return false;
  return left.ancestors.every((entry, index) => {
    const other = right.ancestors[index];
    return Boolean(
      other
      && entry.path === other.path
      && entry.resolvedPath === other.resolvedPath
      && sameStatNodeIdentity(entry.stats, other.stats)
      && sameStatNodeIdentity(entry.resolvedStats, other.resolvedStats)
    );
  });
}

function sameStatNodeIdentity(left, right) {
  return Boolean(
    left
    && right
    && String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && Number(left.mode) === Number(right.mode)
    && Number(left.uid) === Number(right.uid)
  );
}

export function sameNodeExceptMode(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.nlink === right.nlink
  );
}

export function sameNodeIgnoringLinkCount(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
  );
}
