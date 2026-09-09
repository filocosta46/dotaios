import fs from 'node:fs/promises';
import path from 'node:path';
import { readContainedFile, inspectContainedFile, sameContainedFileSnapshot } from './contained-read.mjs';
import { createEvidenceReader } from './evidence-reader.mjs';
import { resolvePortableProjectIdentity } from './projects.mjs';
import { sourceRootIdentity, sourceDigest, sourceFileStamp, sourceByteLimit, eligibleSource, encodeSourceReference, SOURCE_REFERENCE_MAX_CHARS } from './source-reference.mjs';
import { resolveMemoryPolicy } from './memory-policy.mjs';

export const SOURCE_FOLLOW_MIN_BUDGET = 3530;
export const SOURCE_FOLLOW_MAX_BUDGET = 32000;
export { SOURCE_REFERENCE_MAX_CHARS } from "./source-reference.mjs";
export async function followSourceEvidence(options, { filesystem = fs } = {}) {
  const policy = resolveMemoryPolicy({ mode: options.memory, project: options.project });
  if (policy.mode === 'off') return { kind: 'dotaios.source-evidence/v1', status: 'off', receipt: policy.receipt, notice: policy.notice };
  let reference;
  try {
    if (typeof options.follow !== 'string' || options.follow.length > SOURCE_REFERENCE_MAX_CHARS || !/^ds1\.[A-Za-z0-9_-]+$/.test(options.follow)) throw new Error();
    reference = JSON.parse(Buffer.from(options.follow.slice(4), 'base64url').toString('utf8'));
    if (reference.v !== 1 || !eligibleSource(reference.source) || !Number.isSafeInteger(reference.offset) || reference.offset < 0
      || !['shared', 'project'].includes(reference.scope) || !/^[a-f0-9]{64}$/.test(reference.root)
      || !/^[a-f0-9]{64}$/.test(reference.file) || !/^sha256:[a-f0-9]{64}$/.test(reference.digest)) throw new Error();
  } catch { return refusal(policy, 'invalid_reference'); }
  if (reference.scope !== policy.mode) return refusal(policy, 'scope_mismatch');
  if (policy.mode === 'shared' && (!reference.source.startsWith('context/') || reference.project !== null)) return refusal(policy, 'scope_mismatch');
  const budget = options.budget ?? 6000;
  if (!Number.isSafeInteger(budget) || budget < SOURCE_FOLLOW_MIN_BUDGET || budget > SOURCE_FOLLOW_MAX_BUDGET) {
    return { ...refusal(policy, 'insufficient_budget'), minimum: SOURCE_FOLLOW_MIN_BUDGET, maximum: SOURCE_FOLLOW_MAX_BUDGET };
  }
  const root = path.resolve(options.aiosPath);
  try {
    const rootIdentity = await sourceRootIdentity(root, filesystem);
    if (rootIdentity !== reference.root) return refusal(policy, 'source_changed');
    const authorityPath = path.join(root, 'aios.json');
    const authority = await inspectContainedFile(root, authorityPath, { filesystem });
    if (!authority) return refusal(policy, 'source_unavailable');
    const admitProject = async () => {
      const identity = await resolvePortableProjectIdentity({
        aiosPath: root, projectSelector: policy.projectSelector,
        evidenceReader: createEvidenceReader({ roots: [root], filesystem })
      });
      return identity.id === reference.project && reference.source.startsWith(`projects/${identity.slug}/`);
    };
    if (policy.mode === 'project' && !await admitProject()) return refusal(policy, 'scope_mismatch');
    const expectedSource = await inspectContainedFile(root, path.join(root, reference.source), { filesystem });
    if (!expectedSource) return refusal(policy, 'source_unavailable');
    if (sourceFileStamp(expectedSource.stats) !== reference.file
      || rootIdentity !== await sourceRootIdentity(root, filesystem)) return refusal(policy, 'source_changed');
    const observed = await readContainedFile(root, path.join(root, reference.source), {
      filesystem, expectedSnapshot: expectedSource, maxBytes: sourceByteLimit(reference.source), encoding: 'utf8', returnSnapshot: true
    });
    if (!observed) return refusal(policy, 'source_unavailable');
    if (rootIdentity !== await sourceRootIdentity(root, filesystem)
      || !sameContainedFileSnapshot(authority, await inspectContainedFile(root, authorityPath, { filesystem }))
      || `sha256:${sourceDigest(observed.content)}` !== reference.digest || sourceFileStamp(observed.stats) !== reference.file) {
      return refusal(policy, 'source_changed');
    }
    if (policy.mode === 'project' && !await admitProject()) return refusal(policy, 'scope_mismatch');
    const finalSource = await inspectContainedFile(root, path.join(root, reference.source), { filesystem });
    if (!finalSource || sourceFileStamp(finalSource.stats) !== reference.file
      || rootIdentity !== await sourceRootIdentity(root, filesystem)) return refusal(policy, 'source_changed');
    return sourcePage(observed.content, reference, policy, budget);
  } catch (error) {
    const code = String(error?.code || '');
    const reason = code.includes('TOO_LARGE') ? 'source_too_large'
      : code.includes('UTF8') ? 'unsupported_text'
      : code.includes('CHANGED') ? 'source_changed'
      : code.includes('PROJECT_SELECTOR') ? 'project_unavailable'
      : ['ENOENT', 'ENOTDIR'].includes(code) ? 'source_unavailable'
      : 'unsafe_source';
    return refusal(policy, reason);
  }
}

function refusal(policy, reason) {
  return { kind: 'dotaios.source-evidence/v1', receipt: policy.receipt, status: 'refused', reason, recovery: 'Refresh discovery within the current memory scope.' };
}

function sourcePage(content, reference, policy, limit) {
  const bytes = Buffer.from(content, 'utf8');
  const start = reference.offset;
  if (start > bytes.length || (start < bytes.length && (bytes[start] & 0xc0) === 0x80)) return refusal(policy, 'invalid_reference');
  const make = (end) => {
    const result = {
      kind: 'dotaios.source-evidence/v1', status: 'read', receipt: policy.receipt,
      source: reference.source, version: reference.digest,
      coverage: { kind: 'range', from: start, to: end, total: bytes.length, unit: 'utf8-byte' },
      text: bytes.subarray(start, end).toString('utf8'),
      next: end < bytes.length ? encodeSourceReference({ ...reference, offset: end }) : null,
      budget: { limit, used: 0 }
    };
    let used = JSON.stringify(result).length;
    while (used !== result.budget.used) {
      result.budget.used = used;
      used = JSON.stringify(result).length;
    }
    return result;
  };
  const complete = make(bytes.length);
  if (complete.budget.used <= limit) return complete;
  let low = start + 1;
  let high = bytes.length - 1;
  let accepted = null;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    let end = midpoint;
    while (end > start && (bytes[end] & 0xc0) === 0x80) end--;
    const candidate = make(end);
    if (candidate.budget.used <= limit) {
      if (end > start) accepted = candidate;
      low = midpoint + 1;
    } else high = midpoint - 1;
  }
  if (accepted) return accepted;
  let first = start + 1;
  while (first < bytes.length && (bytes[first] & 0xc0) === 0x80) first++;
  return { ...refusal(policy, 'insufficient_budget'), minimum: make(first).budget.used, maximum: SOURCE_FOLLOW_MAX_BUDGET };
}
