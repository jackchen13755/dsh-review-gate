/**
 * 真实仓库上的 canary 断言：紧贴阈值两侧各钉一条。
 *
 * 为什么必须是「阈值本身」而不是「离阈值很远的两侧」：
 * 若用 removed=5 与 removed=60 各钉一条，把 `>=` 改成 `>` 时两条都会绿
 * （5 > 6 假、60 > 6 真），变异存活。对称轴必须是边界本身：N 与 N-1。
 *
 * 这两条的 @canary id 与 mutants.json 里的 trigger.removal-threshold 对应：
 * 变异检定只认「这条 id 的断言红了」，不认「随便红了一条」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyTrigger, REASONS } from '../../lib/trigger.js';

const f = (path, added = [], removed = [], status = 'M') => ({ path, added, removed, status });
const lines = (n) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`);
const snap = (removedCount) => ({
  available: true,
  files: [f('src/a.ts', [], lines(removedCount))],
  totals: { added: 0, removed: removedCount },
});

test('删的行数正好等于阈值 → 必须判 deletion @canary id=trigger.removal-threshold', () => {
  const r = classifyTrigger(snap(6), { thresholds: { removal: 6 } });
  assert.ok(
    r.reasons.includes(REASONS.DELETION),
    `removed=6 阈值=6 必须判 deletion（判据是「达到」），实际 reasons=${JSON.stringify(r.reasons)}`,
  );
});

test('删的行数差一行 → 不许判 deletion @canary id=trigger.removal-threshold', () => {
  const r = classifyTrigger(snap(5), { thresholds: { removal: 6 } });
  assert.equal(
    r.reasons.includes(REASONS.DELETION),
    false,
    `removed=5 阈值=6 不该判 deletion，实际 reasons=${JSON.stringify(r.reasons)}`,
  );
});
