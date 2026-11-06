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

// ------------------------------------------- 假绿回归（2026-11-06，阶段 A）

test('假绿③：files 不是数组 → 必须标 undetermined，不许当成「确实没改动」', () => {
  // 真实故障形状：取证结果畸形（字段被改 / 宿主换了形状）时，
  // 旧代码走 return err（undetermined:false），于是「读不到」被记成「确认没改动」，
  // 门禁瞎了也不会在状态里留下任何痕迹。
  for (const bad of [
    { available: true },
    { available: true, files: undefined },
    { available: true, files: 'oops' },
    { available: true, files: {} },
  ]) {
    const r = classifyTrigger(bad);
    assert.equal(r.trigger, false, `畸形取证不该触发：${JSON.stringify(bad)}`);
    assert.equal(r.undetermined, true, `读不到改动清单必须标 undetermined：${JSON.stringify(bad)}`);
  }

  // 另一侧（反向断言）：空的改动清单是**已确定**的「没有改动」，不能也标成 undetermined，
  // 否则这个字段就退化成「永远是 true」，等于没有信息量。
  const empty = classifyTrigger({ available: true, files: [] });
  assert.equal(empty.trigger, false);
  assert.equal(empty.undetermined, false, '空清单是已确定的「没改动」，必须与「读不到」区分开');
});
