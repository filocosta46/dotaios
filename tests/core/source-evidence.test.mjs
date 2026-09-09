import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { searchAios } from '../../packages/core/src/search.mjs';
import { followSourceEvidence } from '../../packages/core/src/source-evidence.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dotaios-follow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'context'));
  await fs.writeFile(path.join(root, 'aios.json'), '{"schema_version":"1.2.0"}\n');
  return root;
}

test('follow recovers the exact source after topic search hides a late rule behind earlier mentions', async (t) => {
  const aiosPath = await fixture(t);
  // Preserve the independently measured baseline: 2,253 bytes, rule at line 25.
  const filler = 'Historical project background without an operational instruction. '.repeat(22);
  const early = Array.from({ length: 6 }, (_, i) => `Launch policy reference ${i + 1}: historical mention, not the approved rule.\nUnrelated context line.\nAnother separator line.\n`).join('');
  const source = '# Work\n\n## Current Work\n' + filler + '\n\n' + early
    + '\nLaunch policy: APPROVED_RULE_ZETA requires review before release.\n';
  assert.equal(Buffer.byteLength(source), 2253);
  assert.equal(source.split('\n').findIndex((line) => line.includes('APPROVED_RULE_ZETA')) + 1, 25);
  await fs.writeFile(path.join(aiosPath, 'context', 'work.md'), source);
  await fs.writeFile(path.join(aiosPath, 'context', 'decoy.md'), '# Launch policy\n\nHistorical launch policy says DECOY_OLD_RULE; this document is obsolete.\n');
  const [group] = await searchAios({ aiosPath, query: 'launch policy', scope: 'context' });
  const hit = group.results.find((result) => result.file === 'work.md');
  assert.doesNotMatch(JSON.stringify(hit.matches), /APPROVED_RULE_ZETA/);
  const result = await followSourceEvidence({ aiosPath, memory: 'shared', follow: hit.evidence.follow });
  assert.equal(result.status, 'read');
  assert.equal(result.text, source);
  assert.equal(result.source, 'context/work.md');
  assert.deepEqual(result.coverage, { kind: 'range', from: 0, to: Buffer.byteLength(source), total: Buffer.byteLength(source), unit: 'utf8-byte' });
  assert.equal(result.next, null);
  assert.ok(JSON.stringify(result).length <= 6000);
});

test('source references never widen the current memory scope and Off reads nothing', async (t) => {
  const aiosPath = await fixture(t);
  await fs.writeFile(path.join(aiosPath, 'context', 'work.md'), '# Plan\nShared constraint.\n');
  const [group] = await searchAios({ aiosPath, query: 'constraint', scope: 'context' });
  const follow = group.results[0].evidence.follow;
  const scoped = await followSourceEvidence({ aiosPath, memory: 'project', project: 'other-id', follow });
  assert.equal(scoped.reason, 'scope_mismatch');
  assert.equal(scoped.text, undefined);
  const off = await followSourceEvidence({ aiosPath: '/missing', memory: 'off', follow }, {
    filesystem: new Proxy({}, { get() { throw new Error('Off must never access filesystem'); } })
  });
  assert.equal(off.status, 'off');
  assert.equal(off.receipt, 'Memory: Off');
});

async function project(root, slug, id) {
  const directory = path.join(root, 'projects', slug);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'README.md'), `---\nid: ${id}\nproject: ${slug}\n---\n# ${slug}\n`);
  return directory;
}

test('a project research note can be followed only while that project identity remains admitted', async (t) => {
  const aiosPath = await fixture(t);
  const directory = await project(aiosPath, 'alpha', 'alpha-id');
  await project(aiosPath, 'beta', 'beta-id');
  await fs.writeFile(path.join(directory, 'research.md'), '# Research\nA useful outcome.\n');
  const [group] = await searchAios({ aiosPath, query: 'useful', scope: 'projects', projectSelector: 'alpha-id' });
  const follow = group.results[0].evidence.follow;
  const result = await followSourceEvidence({ aiosPath, memory: 'project', project: 'alpha-id', follow });
  assert.equal(result.text, '# Research\nA useful outcome.\n');
  const other = await followSourceEvidence({ aiosPath, memory: 'project', project: 'beta-id', follow });
  assert.equal(other.reason, 'scope_mismatch');
  await fs.writeFile(path.join(directory, 'README.md'), '---\nid: replacement-id\nproject: alpha\n---\n');
  const changed = await followSourceEvidence({ aiosPath, memory: 'project', project: 'alpha-id', follow });
  assert.equal(changed.status, 'refused');
  assert.equal(changed.text, undefined);
});

test('bounded pages cover literal UTF-8 exactly and advance even across a long line', async (t) => {
  const aiosPath = await fixture(t);
  const source = '# Long research\n' + 'A🚀é\\"'.repeat(1500) + '\nFinal rule.\n';
  await fs.writeFile(path.join(aiosPath, 'context', 'long.md'), source);
  const [group] = await searchAios({ aiosPath, query: 'research', scope: 'context' });
  let follow = group.results[0].evidence.follow;
  const pieces = [];
  let end = 0;
  for (let calls = 0; follow && calls < 40; calls++) {
    const result = await followSourceEvidence({ aiosPath, memory: 'shared', follow, budget: 3530 });
    assert.equal(result.status, 'read');
    assert.ok(JSON.stringify(result).length <= 3530);
    assert.equal(result.budget.used, JSON.stringify(result).length);
    assert.equal(result.coverage.from, end);
    assert.ok(result.coverage.to > end);
    assert.doesNotMatch(result.text, /�/);
    end = result.coverage.to;
    pieces.push(result.text);
    follow = result.next;
  }
  assert.equal(follow, null);
  assert.equal(pieces.join(''), source);
  assert.equal(end, Buffer.byteLength(source));
});

test('a source changed after its handle read never releases stale evidence', async (t) => {
  const aiosPath = await fixture(t);
  const file = path.join(aiosPath, 'context', 'work.md');
  await fs.writeFile(file, '# Work\nThe original rule.\n');
  const [group] = await searchAios({ aiosPath, query: 'rule', scope: 'context' });
  let replaced = false;
  const filesystem = new Proxy(fs, { get(target, key) {
    if (key !== 'open') return Reflect.get(target, key);
    return async (...args) => {
      const handle = await fs.open(...args);
      return new Proxy(handle, { get(value, method) {
        if (method === 'close') return async () => {
          await value.close();
          if (args[0] === file && !replaced) {
            replaced = true;
            await fs.writeFile(file, '# Work\nChanged rule.\n');
          }
        };
        const entry = Reflect.get(value, method, value);
        return typeof entry === 'function' ? entry.bind(value) : entry;
      } });
    };
  } });
  const result = await followSourceEvidence({ aiosPath, memory: 'shared', follow: group.results[0].evidence.follow }, { filesystem });
  assert.equal(result.reason, 'source_changed');
  assert.equal(result.text, undefined);
});

test('a Shared brief carries a usable exact-source reference beside its clipped current work', async (t) => {
  const { buildWorkingContext } = await import('../../packages/core/src/working-context.mjs');
  const aiosPath = await fixture(t);
  const source = '# Work\n\n## Current Work\n' + 'Background context. '.repeat(90) + '\nApproved rule: wait for review.\n';
  await fs.writeFile(path.join(aiosPath, 'context', 'work.md'), source);
  const { context, rendered } = await buildWorkingContext(aiosPath, { memory: 'shared' });
  assert.doesNotMatch(rendered, /wait for review/);
  assert.match(rendered, /context\/work.md/);
  const result = await followSourceEvidence({ aiosPath, memory: 'shared', follow: context.sources.currentWork.follow });
  assert.equal(result.text, source);
  assert.equal(context.sources.currentWork.coverage.kind, 'excerpt');
});

test('a selected README brief offers exact follow without reading an oversized sibling body', async (t) => {
  const { buildWorkingContext } = await import('../../packages/core/src/working-context.mjs');
  const aiosPath = await fixture(t);
  const directory = await project(aiosPath, 'alpha', 'alpha-id');
  const sibling = await project(aiosPath, 'beta', 'beta-id');
  await fs.appendFile(path.join(sibling, 'README.md'), 'Sibling body. '.repeat(100000));
  const source = await fs.readFile(path.join(directory, 'README.md'), 'utf8') + 'Background. '.repeat(120) + '\nLate constraint.\n';
  await fs.writeFile(path.join(directory, 'README.md'), source);
  const { context, rendered } = await buildWorkingContext(aiosPath, { memory: 'project', project: 'alpha-id' });
  assert.doesNotMatch(rendered, /Late constraint/);
  const result = await followSourceEvidence({ aiosPath, memory: 'project', project: 'alpha-id', follow: context.activeProject.sourceEvidence.follow });
  assert.equal(result.text, source);
  const small = await buildWorkingContext(aiosPath, { memory: 'project', project: 'alpha-id', visibleCharacterBudget: 256 });
  assert.equal(small.context.activeProject, null);
  assert.equal(small.context.coverage.selectedProjectReadme.budgetOmitted, true);
  assert.doesNotMatch(small.rendered, /ds1\./);
});

test('unrelated siblings preserve a reference while edits, deletion and root replacement refuse it', async (t) => {
  const aiosPath = await fixture(t);
  const file = path.join(aiosPath, 'context', 'work.md');
  await fs.writeFile(file, '# Work\nA source rule.\n');
  const [group] = await searchAios({ aiosPath, query: 'rule', scope: 'context' });
  const follow = group.results[0].evidence.follow;
  await fs.writeFile(path.join(aiosPath, 'context', 'sibling.md'), '# Other work\n');
  assert.equal((await followSourceEvidence({ aiosPath, follow, memory: 'shared' })).status, 'read');
  await fs.writeFile(file, '# Work\nA different rule.\n');
  assert.equal((await followSourceEvidence({ aiosPath, follow, memory: 'shared' })).reason, 'source_changed');
  await fs.unlink(file);
  assert.equal((await followSourceEvidence({ aiosPath, follow, memory: 'shared' })).reason, 'source_unavailable');
  const displaced = `${aiosPath}-old`;
  t.after(() => fs.rm(displaced, { recursive: true, force: true }));
  await fs.rename(aiosPath, displaced);
  await fs.mkdir(aiosPath);
  assert.equal((await followSourceEvidence({ aiosPath, follow, memory: 'shared' })).reason, 'source_changed');
});

test('search does not offer follow outside supported families or above the stricter header ceiling', async (t) => {
  const aiosPath = await fixture(t);
  await fs.writeFile(path.join(aiosPath, 'context', 'work.md'), '# Constraint\n' + 'x'.repeat(1024 * 1024));
  await fs.writeFile(path.join(aiosPath, 'context', 'research.md'), '# Constraint\n' + 'x'.repeat(1024 * 1024));
  await fs.mkdir(path.join(aiosPath, 'vault'));
  await fs.writeFile(path.join(aiosPath, 'vault', 'original.md'), '# Constraint\n');
  const [context] = await searchAios({ aiosPath, query: 'constraint', scope: 'context' });
  const header = context.results.find((entry) => entry.file === 'work.md');
  assert.equal(header.evidence.follow, null);
  assert.equal(header.evidence.reason, 'source_too_large');
  const note = context.results.find((entry) => entry.file === 'research.md');
  assert.equal(typeof note.evidence.follow, 'string');
  const page = await followSourceEvidence({ aiosPath, follow: note.evidence.follow, memory: 'shared' });
  assert.equal(page.status, 'read');
  assert.equal(page.coverage.total, 1048589);
  const [vault] = await searchAios({ aiosPath, query: 'constraint', scope: 'vault' });
  assert.equal(vault.results[0].evidence, undefined);
});

test('a changed file is refused from its observation before its new body is read', async (t) => {
  const aiosPath = await fixture(t);
  const file = path.join(aiosPath, 'context', 'work.md');
  await fs.writeFile(file, '# Rule\nOriginal.\n');
  const [group] = await searchAios({ aiosPath, query: 'rule', scope: 'context' });
  await fs.writeFile(file, '# Rule\nReplacement content must not be read.\n');
  let bodyReads = 0;
  const filesystem = new Proxy(fs, { get(target, key) {
    if (key !== 'open') return Reflect.get(target, key);
    return async (...args) => {
      const handle = await fs.open(...args);
      return new Proxy(handle, { get(value, method) {
        if (method === 'read') return async (...parameters) => {
          if (args[0] === file) bodyReads++;
          return value.read(...parameters);
        };
        const entry = Reflect.get(value, method, value);
        return typeof entry === 'function' ? entry.bind(value) : entry;
      } });
    };
  } });
  const result = await followSourceEvidence({ aiosPath, follow: group.results[0].evidence.follow, memory: 'shared' }, { filesystem });
  assert.equal(result.reason, 'source_changed');
  assert.equal(bodyReads, 0);
});

test('sources at the existing 1 MiB header and 4 MiB note boundaries remain followable', async (t) => {
  const aiosPath = await fixture(t);
  for (const [name, bytes] of [['work.md', 1024 * 1024], ['research.md', 4 * 1024 * 1024]]) {
    const prefix = '# Boundary\n';
    await fs.writeFile(path.join(aiosPath, 'context', name), prefix + 'x'.repeat(bytes - prefix.length));
  }
  const [group] = await searchAios({ aiosPath, query: 'boundary', scope: 'context' });
  assert.equal(group.results.length, 2);
  for (const hit of group.results) {
    const result = await followSourceEvidence({ aiosPath, memory: 'shared', follow: hit.evidence.follow });
    assert.equal(result.status, 'read');
    assert.equal(result.coverage.total, hit.file === 'work.md' ? 1048576 : 4194304);
    assert.ok(result.coverage.to > 0);
    assert.ok(result.budget.used <= 6000);
  }
});

test('a source replaced with a symlink never releases its target bytes', async (t) => {
  const aiosPath = await fixture(t);
  const source = path.join(aiosPath, 'context', 'work.md');
  await fs.writeFile(source, '# Rule\nOriginal source.\n');
  const [group] = await searchAios({ aiosPath, query: 'rule', scope: 'context' });
  await fs.writeFile(path.join(aiosPath, 'context', 'replacement.md'), 'Replacement must not be exposed.');
  await fs.unlink(source);
  await fs.symlink('replacement.md', source);
  const result = await followSourceEvidence({ aiosPath, memory: 'shared', follow: group.results[0].evidence.follow });
  assert.equal(result.status, 'refused');
  assert.equal(result.text, undefined);
  assert.doesNotMatch(JSON.stringify(result), /Replacement must not be exposed/);
});

test('near-limit Unicode source paths offer complete continuation or an explicit discovery refusal', async (t) => {
  const aiosPath = await fixture(t);
  const source = '# Boundary\n' + 'Literal source content. '.repeat(1000);
  for (const accents of [13, 17]) {
    await t.test(`${accents} accented filename characters`, async () => {
      const relative = ['context', ...Array(4).fill('é'.repeat(100)), 'é'.repeat(accents) + 'a'.repeat(21 - accents) + '.md'].join('/');
      const file = path.join(aiosPath, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, source);
      const [group] = await searchAios({ aiosPath, query: 'boundary', scope: 'context' });
      const evidence = group.results.find((hit) => hit.evidence?.source === relative)?.evidence;
      assert.ok(evidence);
      if (accents === 13) assert.equal(typeof evidence.follow, 'string');
      if (!evidence.follow) {
        assert.equal(evidence.reason, 'source_reference_too_large');
      } else {
        const pieces = [];
        let follow = evidence.follow;
        let end = 0;
        for (let calls = 0; follow && calls < 64; calls++) {
          const page = await followSourceEvidence({ aiosPath, memory: 'shared', follow, budget: 3530 });
          assert.equal(page.status, 'read', `Continuation at byte ${end}: ${page.reason}`);
          assert.equal(page.coverage.from, end);
          assert.ok(page.coverage.to > end);
          assert.ok(page.budget.used <= 3530);
          pieces.push(page.text);
          end = page.coverage.to;
          follow = page.next;
        }
        assert.equal(follow, null);
        assert.equal(pieces.join(''), source);
        assert.equal(end, Buffer.byteLength(source));
      }
      assert.equal(await fs.readFile(file, 'utf8'), source);
    });
  }
});

test('nested context and project discovery emits portable follow paths on the current host', async (t) => {
  const aiosPath = await fixture(t);
  await project(aiosPath, 'alpha', 'alpha-id');
  const source = '# Nested rule\nKeep the original constraint.\n';
  for (const [relative, options] of [
    ['context/research/constraints.md', { scope: 'context', memory: 'shared' }],
    ['projects/alpha/research/constraints.md', { scope: 'projects', memory: 'project', projectSelector: 'alpha-id' }]
  ]) {
    const file = path.join(aiosPath, ...relative.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, source);
    const [group] = await searchAios({ aiosPath, query: 'constraint', ...options });
    assert.equal(group.results[0].evidence?.source, relative);
    assert.equal(typeof group.results[0].evidence.follow, 'string');
    const result = await followSourceEvidence({
      aiosPath, memory: options.memory, project: options.projectSelector,
      follow: group.results[0].evidence.follow
    });
    assert.equal(result.status, 'read');
    assert.equal(result.source, relative);
    assert.equal(result.text, source);
    assert.equal(await fs.readFile(file, 'utf8'), source);
  }
});
