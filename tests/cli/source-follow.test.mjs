import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const cli = new URL('../../packages/cli/src/index.mjs', import.meta.url).pathname;
const server = new URL('../../packages/mcp/src/server.mjs', import.meta.url).pathname;
function run(root, args) {
  return spawnSync(process.execPath, [cli, ...args, '--path', root], { encoding: 'utf8', env: { ...process.env, DOTAIOS_ALLOW_AUTO_SYNC_HOOK: '0' } });
}
function mcp(root, name, args) {
  const out = spawnSync(process.execPath, [server, '--path', root], { encoding: 'utf8', input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })+'\n' });
  assert.equal(out.status, 0, out.stderr);
  const result = JSON.parse(out.stdout);
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  return JSON.parse(result.result.content[0].text);
}

test('CLI and existing MCP search follow the same brief source without query guessing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotaios-follow-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'context'));
  fs.writeFileSync(path.join(root, 'aios.json'), '{"schema_version":"1.2.0"}\n');
  const source = '# Work\n\n## Current Work\n' + 'Background. '.repeat(95) + '\nRequire review before release.\n';
  fs.writeFileSync(path.join(root, 'context', 'work.md'), source);
  const brief = run(root, ['brief', '--compact', '--memory', 'shared', '--json']);
  assert.equal(brief.status, 0, brief.stderr);
  const markdown = JSON.parse(brief.stdout).hookSpecificOutput.additionalContext;
  const follow = /^> Follow: (\S+)$/m.exec(markdown)?.[1];
  assert.ok(follow);
  const result = run(root, ['search', '--follow', follow, '--memory', 'shared', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const fromCli = JSON.parse(result.stdout);
  const fromMcp = mcp(root, 'search_aios', { follow, memory: 'shared' });
  assert.deepEqual(fromMcp, fromCli);
  assert.equal(fromCli.text, source);
  const queried = mcp(root, 'search_aios', { query: 'review', scope: 'context' });
  assert.equal(queried.results[0].evidence.follow, follow);
  const followed = mcp(root, 'search_aios', { follow: queried.results[0].evidence.follow, memory: 'shared' });
  assert.equal(followed.text, source);
  assert.equal(fs.readFileSync(path.join(root, 'context', 'work.md'), 'utf8'), source);
});

test('follow rejects query-only options and malformed references without opening memory in Off mode', () => {
  const missing = path.join(os.tmpdir(), `dotaios-private-follow-${process.pid}`);
  const off = run(missing, ['search', '--follow', 'not-a-reference', '--memory', 'off', '--json']);
  assert.equal(off.status, 0, off.stderr);
  assert.equal(JSON.parse(off.stdout).status, 'off');
  const fromMcp = mcp(missing, 'search_aios', { follow: 'not-a-reference', memory: 'off' });
  assert.equal(fromMcp.status, 'off');
  for (const filter of [['--scope', 'context'], ['--limit', '1'], ['extra-query']]) {
    const rejected = run(missing, ['search', '--follow', 'not-a-reference', '--memory', 'shared', ...filter]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /cannot be combined/);
  }
  assert.equal(fs.existsSync(missing), false);
});
