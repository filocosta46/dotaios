// Shared source-observation format for the existing read owners. References
// are derived locators; only followSourceEvidence admits a read request.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { shouldSkipEntry } from './search-eligibility.mjs';

export const SOURCE_REFERENCE_MAX_CHARS = 1536;
export const sourceDigest = (value) => createHash('sha256').update(value).digest('hex');
export const sourceFileStamp = (stats) => sourceDigest([stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(':'));
export const sourceRootStamp = (stats) => sourceDigest(`${stats.dev}:${stats.ino}`);

// Root identity excludes modification times: unrelated sibling edits are not
// changes to the source. Callers retain their in-request containment checks.
export async function sourceRootIdentity(root, filesystem = fs) {
  const canonical = await filesystem.realpath(root);
  const stats = await filesystem.lstat(canonical, { bigint: true });
  if (!stats.isDirectory()) throw new Error('Unsafe source root');
  return sourceRootStamp(stats);
}

export function sourceEvidence({ source, content, stats, rootIdentity, projectId = null }) {
  const supported = eligibleSource(source) && (source.startsWith('context/') || (source.startsWith('projects/') && projectId));
  if (!supported) return null;
  const version = `sha256:${sourceDigest(content)}`;
  const sourceBytes = Buffer.byteLength(content);
  if (sourceBytes > sourceByteLimit(source)) {
    return { source, version, coverage: { kind: 'excerpt' }, follow: null, reason: 'source_too_large' };
  }
  const reference = {
    v: 1, source, scope: projectId ? 'project' : 'shared', project: projectId,
    root: rootIdentity, file: sourceFileStamp(stats), digest: version, offset: 0
  };
  // Reserve the largest possible continuation offset before offering the first
  // page. Otherwise offset digit growth can make a later reference unusable.
  if (encodeSourceReference({ ...reference, offset: sourceBytes }).length > SOURCE_REFERENCE_MAX_CHARS) {
    return { source, version, coverage: { kind: 'excerpt' }, follow: null, reason: 'source_reference_too_large' };
  }
  const follow = encodeSourceReference(reference);
  return { source, version, coverage: { kind: 'excerpt' }, follow };
}

export function sourceByteLimit(source) {
  return /^context\/(identity|priorities|work)\.md$/i.test(source) || /^projects\/[^/]+\/README\.md$/i.test(source)
    ? 1024 * 1024 : 4 * 1024 * 1024;
}
export function eligibleSource(source) {
  return typeof source === 'string' && source.length <= 512 && !/[\\\p{Cc}]/u.test(source)
    && /\.md$/i.test(source) && source.split('/').every((part) => part && part !== '..' && !shouldSkipEntry(part))
    && /^(context\/|projects\/[^/]+\/)/.test(source);
}

export const encodeSourceReference = (reference) => `ds1.${Buffer.from(JSON.stringify(reference)).toString('base64url')}`;

export function renderSourceEvidence(evidence) {
  if (!evidence) return [];
  return [
    `> Source: ${evidence.source} (excerpt; ${evidence.version})`,
    evidence.follow ? `> Follow: ${evidence.follow}` : `> Exact follow unavailable: ${evidence.reason}`
  ];
}
