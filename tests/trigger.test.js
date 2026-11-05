import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyTrigger, isCommentOnly, REASONS } from '../lib/trigger.js';

const f = (path, added = [], removed = [], status = 'M') => ({ path, added, removed, status });

test('空输入 / undefined / null：不触发且不抛', () => {
  for (const s of [undefined, null, {}, { available: false }, { available: true, files: [] }]) {
    const r = classifyTrigger(s);
    assert.equal(r.trigger, false, `输入 ${JSON.stringify(s)} 不该触发`);
  }
});

test('取证不可得：标记 undetermined 并放行（不许判成「没改动」）', () => {
  const r = classifyTrigger({ available: false, files: [] });
  assert.equal(r.trigger, false);
  assert.equal(r.undetermined, true, '必须区分「不可得」与「确实没改动」');
});

test('单个源码文件改注释：不触发', () => {
  const r = classifyTrigger({ available: true, files: [f('src/a.ts', ['// 注释'], ['// 旧注释'])] });
  assert.equal(r.trigger, false);
});

test('合法文件 + undefined / 空串路径：不触发且不抛', () => {
  const r = classifyTrigger({
    available: true,
    files: [f('src/a.ts', ['const a = 1']), { path: undefined }, { path: '' }],
  });
  assert.equal(typeof r.trigger, 'boolean');
  assert.equal(r.reasons.includes(REASONS.DECISION), false);
});

test('根级 package.json 改动：触发 config', () => {
  const r = classifyTrigger({ available: true, files: [f('package.json', ['+  "scripts": {}'])] });
  assert.equal(r.trigger, true);
  assert.ok(r.reasons.includes(REASONS.CONFIG));
});

test('未登记旁支：判定表达式仍被识别为 decision', () => {
  const r = classifyTrigger({
    available: true,
    files: [f('weird/path.xyz', ['  if (x.every(Boolean)) {', '    return new Set([a])'])],
  });
  assert.equal(r.trigger, true);
  assert.ok(r.reasons.includes(REASONS.DECISION));
});

test('两个不同首段目录：触发 cross-module', () => {
  const r = classifyTrigger({
    available: true,
    files: [f('apps/a/x.ts', ['const a = 1']), f('packages/b/y.ts', ['const b = 2'])],
  });
  assert.ok(r.reasons.includes(REASONS.CROSS_MODULE));
});

test('安全敏感路径：触发 security', () => {
  const r = classifyTrigger({ available: true, files: [f('src/auth/token.ts', ['const t = 1'])] });
  assert.ok(r.reasons.includes(REASONS.SECURITY));
});

test('公共 API 签名变更：触发 public-api', () => {
  const r = classifyTrigger({
    available: true,
    files: [f('src/api.ts', ['export function handler(a: string): void {'])],
  });
  assert.ok(r.reasons.includes(REASONS.PUBLIC_API));
});

test('删除文件：触发 deletion', () => {
  const r = classifyTrigger({ available: true, files: [f('src/old.ts', [], [], 'D')] });
  assert.ok(r.reasons.includes(REASONS.DELETION));
});

test('规模兜底：总量超阈值触发 volume', () => {
  const big = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i}`);
  const r = classifyTrigger({ available: true, files: [f('src/big.ts', big)] }, { thresholds: { volume: 120 } });
  assert.ok(r.reasons.includes(REASONS.VOLUME));
});

test('纯注释改动：压掉 decision 与 volume 两类误报', () => {
  const lines = Array.from({ length: 200 }, () => '// 只是注释，不是判定');
  const r = classifyTrigger({ available: true, files: [f('src/a.ts', lines)] });
  assert.equal(r.reasons.includes(REASONS.DECISION), false);
  assert.equal(r.reasons.includes(REASONS.VOLUME), false);
  assert.equal(r.trigger, false);
});

test('锁文件 / dist / node_modules：永不计入', () => {
  const r = classifyTrigger({
    available: true,
    files: [f('pnpm-lock.yaml', ['x'.repeat(500)]), f('dist/out.js', ['if (a) {}']), f('node_modules/m/i.js', ['if (b) {}'])],
  });
  assert.equal(r.trigger, false);
});

test('ignoreGlobs 命中：不触发', () => {
  const r = classifyTrigger(
    { available: true, files: [f('docs/generated/a.ts', ['if (a) {}'])] },
    { ignoreGlobs: ['docs/generated/**'] },
  );
  assert.equal(r.trigger, false);
});

test('isCommentOnly：空数组为 true；混入代码为 false', () => {
  assert.equal(isCommentOnly([]), true);
  assert.equal(isCommentOnly([{ added: ['// a'], removed: [''] }]), true);
  assert.equal(isCommentOnly([{ added: ['// a', 'const x = 1'], removed: [] }]), false);
});

test('门槛两侧都验：阈值以下不触发，以上触发（只验一边等于只锁半扇门）', () => {
  const files = [f('src/a.ts', Array.from({ length: 10 }, (_, i) => `const a${i} = ${i}`))];
  const low = classifyTrigger({ available: true, files }, { thresholds: { volume: 100 } });
  assert.equal(low.trigger, false, '低于阈值不该触发');
  const high = classifyTrigger({ available: true, files }, { thresholds: { volume: 5 } });
  assert.equal(high.trigger, true, '高于阈值必须触发');
});
