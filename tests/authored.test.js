import test from 'node:test';
import assert from 'node:assert/strict';

import { scopeDiffToAuthored, toRootRelative } from '../lib/authored.js';

const diff = (...paths) => ({
  available: true,
  digest: 'D1',
  files: paths.map(path => ({ path, status: 'M', added: ['x'], removed: ['y'] })),
  totals: { added: 1, removed: 1 },
});

/**
 * 「只评审本会话自己改的改动」。
 *
 * 这里的边界比正例重要：收敛错了会**静默漏审**（把自己的改动也排除），
 * 所以凡是「无法可靠归属」的输入都必须保持原范围。
 */
test('能归属：只保留本会话写过的文件，其余记为排除', () => {
  const r = scopeDiffToAuthored(diff('src/a.ts', 'src/b.ts'), ['/repo/src/a.ts'], '/repo');
  assert.equal(r.applied, true);
  assert.deepEqual(r.diff.files.map(f => f.path), ['src/a.ts']);
  assert.deepEqual(r.excluded, ['src/b.ts']);
  assert.equal(r.reason, 'scoped');
});

test('本会话没有写入记录 → 不收敛（否则会把自己的改动全排除，静默漏审）', () => {
  const r = scopeDiffToAuthored(diff('src/a.ts'), [], '/repo');
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'no-observed-writes');
  assert.equal(r.diff.files.length, 1, '必须保持原范围');
});

test('观察记录都不在这个仓库下 → 不收敛（归属不可判定）', () => {
  const r = scopeDiffToAuthored(diff('src/a.ts'), ['/other/repo/x.ts'], '/repo');
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'observed-outside-root');
});

test('全部文件都属于别的会话 → 收敛为空并明确标记 all-others', () => {
  const r = scopeDiffToAuthored(diff('src/other.ts'), ['/repo/src/mine.ts'], '/repo');
  assert.equal(r.applied, true);
  assert.equal(r.diff.files.length, 0);
  assert.equal(r.reason, 'all-others');
});

test('Windows 反斜杠路径也能归属（同一文件不得因分隔符不同被判成别人的）', () => {
  const r = scopeDiffToAuthored(diff('src/a.ts'), ['/repo/src/a.ts'], '/repo');
  assert.equal(r.applied, true);
  assert.equal(r.diff.files.length, 1);
});

test('边界输入：空 diff / 非法参数不抛且不收敛', () => {
  for (const input of [undefined, null, {}, { files: [] }, { files: 'x' }]) {
    const r = scopeDiffToAuthored(input, ['/repo/a.ts'], '/repo');
    assert.equal(r.applied, false);
  }
  assert.equal(scopeDiffToAuthored(diff('a.ts'), undefined, undefined).applied, false);
});

test('toRootRelative：根下 / 根外 / 根自身 / 空串', () => {
  assert.equal(toRootRelative('/repo/src/a.ts', '/repo'), 'src/a.ts');
  assert.equal(toRootRelative('/repo', '/repo'), undefined);
  assert.equal(toRootRelative('/other/a.ts', '/repo'), undefined);
  assert.equal(toRootRelative('', '/repo'), undefined);
  assert.equal(toRootRelative('/repo/a.ts', ''), undefined);
});

test('嵌套路径不会被前缀误判（repo 与 repo-two 不是同一个仓库）', () => {
  const r = scopeDiffToAuthored(diff('src/a.ts'), ['/repo-two/src/a.ts'], '/repo');
  assert.equal(r.applied, false, '/repo-two 不属于 /repo');
});
