import test from 'node:test';
import assert from 'node:assert/strict';

import { parseUnifiedDiff, digestOf, collectDiff } from '../lib/evidence.js';

const SAMPLE = [
  'diff --git a/package.json b/package.json',
  'index 111..222 100644',
  '--- a/package.json',
  '+++ b/package.json',
  '@@ -1,0 +1,1 @@',
  '+  "scripts": { "a": "b" }',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+export const x = 1',
  '+export const y = 2',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,1 +0,0 @@',
  '-const old = 1',
].join('\n');

test('parseUnifiedDiff：识别新增 / 删除 / 修改，并正确归集增删行', () => {
  const files = parseUnifiedDiff(SAMPLE);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));

  assert.ok(byPath['package.json'], '普通修改文件必须出现');
  assert.deepEqual(byPath['package.json'].added, ['  "scripts": { "a": "b" }']);

  assert.equal(byPath['src/new.ts'].status, 'A');
  assert.equal(byPath['src/new.ts'].added.length, 2);

  assert.equal(byPath['src/gone.ts'].status, 'D');
  assert.deepEqual(byPath['src/gone.ts'].removed, ['const old = 1']);
});

test('digest 稳定性：同样内容必须同摘要', () => {
  const a = parseUnifiedDiff(SAMPLE);
  const b = parseUnifiedDiff(SAMPLE);
  assert.equal(digestOf(a, []), digestOf(b, []));
});

test('digest 敏感性（正向断言）：改一个字符摘要就必须变，否则新鲜度闸形同虚设', () => {
  const base = parseUnifiedDiff(SAMPLE);
  const changed = parseUnifiedDiff(SAMPLE.replace('"a": "b"', '"a": "c"'));
  assert.notEqual(digestOf(base, []), digestOf(changed, []), '改一个字符必须改变摘要');

  const withUntracked = digestOf(base, [{ path: 'x.ts', content: 'a' }]);
  assert.notEqual(digestOf(base, []), withUntracked, '新增未跟踪文件也必须改变摘要');
});

test('collectDiff：非 git 目录 → available=false（交给上层 fail-open）', async () => {
  const r = await collectDiff('/tmp/whatever', {
    runner: async () => ({ ok: false, stdout: '' }),
    readFile: async () => '',
  });
  assert.equal(r.available, false);
  assert.ok(r.reason, '必须给出原因，便于 status 与排障');
});

test('collectDiff：cwd 为空 → available=false，不抛', async () => {
  const r = await collectDiff('', { runner: async () => ({ ok: true, stdout: '' }), readFile: async () => '' });
  assert.equal(r.available, false);
});

test('collectDiff：未跟踪新文件也要进快照（git diff 看不到它们）', async () => {
  const calls = [];
  const runner = async (file, args) => {
    calls.push(args.join(' '));
    if (args.includes('rev-parse')) return { ok: true, stdout: 'true' };
    if (args.includes('diff')) return { ok: true, stdout: SAMPLE };
    if (args.includes('ls-files')) return { ok: true, stdout: 'src/extra.ts\n' };
    return { ok: true, stdout: '' };
  };
  const r = await collectDiff('/repo', { runner, readFile: async () => 'export const z = 1' });

  assert.equal(r.available, true);
  const paths = r.files.map((f) => f.path);
  assert.ok(paths.includes('src/extra.ts'), '未跟踪文件必须在快照里，否则门禁对新建文件失明');
  assert.ok(r.totals.added >= 1);
  assert.match(r.digest, /^[0-9a-f]{64}$/);
});
