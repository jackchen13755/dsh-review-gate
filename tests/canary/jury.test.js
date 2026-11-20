/**
 * 真实仓库上的 canary 断言：陪审团（M5）的三条判据必须能红。
 *
 * 为什么单独放 tests/canary/：mutants.json 的 baselineCmd 只跑这个目录，
 * 只有在这里的具名断言才会被变异检定看见（主测试集里的同款断言不在基线内）。
 *
 * 三条分别对应三个最可能的退化形态：
 *  ① 三席齐备要求被摘掉（两票 pass 也算通过）
 *  ② 多数门槛写成 >（恰好达到门槛时静默失效）
 *  ③ 单票结论集合校验被摘掉（'PASS' 这种拼写错误被收下）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateJuryForGate, aggregateVotes } from '../../lib/jury.js';

const v = (role, verdict, extra = {}) => ({
  role,
  verdict,
  basis: { kind: 'file', ref: `lib/${role}.js` },
  ...extra,
});
/** pass 票必须由 expert 支撑（P0-1），且三票 ref 互不相同。 */
const expertPass = (role, ref) => ({
  role,
  verdict: 'pass',
  basis: { kind: 'expert', ref },
});

test('门禁层：三席未齐时 2 票 pass 不能算通过 @canary id=jury.min-seats', () => {
  // 两条都是合法 pass 票（不同 expert 证据），只差「第三席没投」这一格：
  // 若去掉 cast < seats 判断，2/2 就会算成 pass。
  const r = aggregateJuryForGate([expertPass('fact', 'call-1'), expertPass('opposition', 'call-2')]);
  assert.equal(r.verdict, 'unavailable', '两票 pass 可能只是第三票还没投，不能当通过');
});

test('多数门槛：2/3 pass 必须通过（>= 不是 >） @canary id=jury.majority-threshold', () => {
  const r = aggregateVotes([
    { role: 'fact', verdict: 'pass' },
    { role: 'opposition', verdict: 'pass' },
    { role: 'gap', verdict: 'fail' },
  ]);
  assert.equal(r.verdict, 'pass');
  assert.equal(r.need, 2);
});

test('单票结论集合：未知 verdict 必须 unavailable @canary id=jury.verdict-set', () => {
  const r = aggregateVotes([{ role: 'fact', verdict: 'PASS' }]);
  assert.equal(r.verdict, 'unavailable', '大小写不同的结论是未知值，不能被收下');
});
