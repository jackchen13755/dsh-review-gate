import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REVIEW_EXPERT_ALIASES,
  REVIEW_TOOL_NAMES,
  expertNamesOfCall,
  isReviewExpert,
  isReviewExpertCall,
  isReviewToolName,
  normalizeExpertName,
} from '../lib/review-expert.js';

/**
 * 「谁算评审」的纯函数判定。这是判定代码，所以每条规则都给正反两面：
 * 只验「没漏」不验「没误放」的话，把判据放宽成 `return true` 也会全绿。
 */

const call = (name, args) => ({ name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });

test('被接受的专家别名就是那四个（声明与真实写法一致）', () => {
  assert.deepEqual([...REVIEW_EXPERT_ALIASES], [
    '代码审查工程师',
    'engineering-code-reviewer',
    'code-reviewer',
    'engineering/code-reviewer',
  ]);
  for (const alias of REVIEW_EXPERT_ALIASES) assert.equal(isReviewExpert(alias), true, alias);
});

test('归一化：首尾空白、内部多空白、大小写都不影响识别', () => {
  assert.equal(normalizeExpertName('  Code-Reviewer  '), 'code-reviewer');
  assert.equal(normalizeExpertName('代码审查 工程师'), '代码审查 工程师');
  assert.equal(isReviewExpert('  CODE-REVIEWER '), true);
  assert.equal(isReviewExpert('代码审查工程师 '), true);
  assert.equal(isReviewExpert(' engineering/code-reviewer\t'), true);
});

test('反向：名字里带这几个字但不是它 → 不算（精确别名，不做子串包含）', () => {
  for (const name of [
    '代码审查工程师助理',
    '代码审查工程师-2',
    'engineering-code-reviewer-x',
    'code-reviewers',
    '安全代码审查工程师',
    'code_reviewer',
  ]) {
    assert.equal(isReviewExpert(name), false, `${name} 不该被当成代码审查工程师`);
  }
});

test('边界输入：非字符串 / 空值 / 只有空白 → false，且不抛', () => {
  for (const value of [undefined, null, '', '   ', 42, true, {}, [], () => {}]) {
    assert.equal(isReviewExpert(value), false, JSON.stringify(String(value)));
  }
});

test('工具名：两种召唤工具都认，且认命名空间前缀', () => {
  for (const name of REVIEW_TOOL_NAMES) assert.equal(isReviewToolName(name), true, name);
  assert.equal(REVIEW_TOOL_NAMES.includes('summon_expert'), true);
  assert.equal(REVIEW_TOOL_NAMES.includes('summon_experts'), true);
  assert.equal(isReviewToolName('mcp__dsh__summon_expert'), true);
  assert.equal(isReviewToolName('x__summon_experts'), true);
});

test('工具名反向：相似但不相同的名字不算（子串匹配会误伤）', () => {
  for (const name of [
    'summon_expert_v2',
    'summon_experts_backup',
    'xsummon_expert',
    'list_experts',
    'summon',
    'bash',
    'dsh_code_review', // 旧入口已卸载：即使名字出现，也不再是评审证据
  ]) {
    assert.equal(isReviewToolName(name), false, name);
  }
  assert.equal(isReviewToolName(undefined), false);
  assert.equal(isReviewToolName(42), false);
});

test('expertNamesOfCall：单专家 / 批量 / 裸字符串元素 / 字符串 JSON 都能读出', () => {
  assert.deepEqual(expertNamesOfCall(call('summon_expert', { expert: '代码审查工程师', task: 'x' })), ['代码审查工程师']);
  assert.deepEqual(expertNamesOfCall(call('summon_experts', { experts: [{ expert: 'UI 设计师' }, { expert: 'code-reviewer' }] })), ['UI 设计师', 'code-reviewer']);
  assert.deepEqual(expertNamesOfCall(call('summon_experts', { experts: ['代码审查工程师'] })), ['代码审查工程师']);
  // 宿主可能先给对象、也可能给 JSON 字符串，两种形状都要能读
  assert.deepEqual(expertNamesOfCall({ name: 'summon_expert', arguments: { expert: '代码审查工程师' } }), ['代码审查工程师']);
});

test('expertNamesOfCall 边界：缺参数 / 坏 JSON / 非对象 / 无 expert 字段 → 空数组且不抛', () => {
  for (const bad of [
    undefined,
    null,
    {},
    { name: 'summon_expert' },
    { name: 'summon_expert', arguments: '{坏 JSON' },
    { name: 'summon_expert', arguments: 42 },
    { name: 'summon_expert', arguments: 'null' },
    { name: 'summon_expert', arguments: '[]' },
    { name: 'summon_expert', arguments: { experts: [null, 42, {}] } },
  ]) {
    assert.deepEqual(expertNamesOfCall(bad), [], JSON.stringify(bad));
  }
});

test('isReviewExpertCall：工具名与专家参数必须同时命中', () => {
  // ① 都命中 → 算
  assert.equal(isReviewExpertCall(call('summon_expert', { expert: '代码审查工程师' })), true);
  // ② 工具名对、专家不对 → 不算（否则叫 UI 设计师也成评审）
  assert.equal(isReviewExpertCall(call('summon_expert', { expert: 'UI 设计师' })), false);
  // ③ 专家对、工具名不对 → 不算（别的工具传同样的参数不能冒充评审）
  assert.equal(isReviewExpertCall(call('bash', { expert: '代码审查工程师' })), false);
  // ④ 批量里含一位审查工程师 → 算（批量就是并发跑，评审确实发生了）
  assert.equal(
    isReviewExpertCall(call('summon_experts', { experts: [{ expert: 'UI 设计师' }, { expert: 'code-reviewer' }] })),
    true,
  );
  // ⑤ 批量里没有审查工程师 → 不算
  assert.equal(
    isReviewExpertCall(call('summon_experts', { experts: [{ expert: 'UI 设计师' }, { expert: '软件架构师' }] })),
    false,
  );
});

test('isReviewExpertCall 边界：undefined / null / 缺字段 → false，不抛', () => {
  for (const bad of [undefined, null, 42, {}, { name: 'summon_expert' }, { name: 'summon_expert', arguments: undefined }]) {
    assert.equal(isReviewExpertCall(bad), false, JSON.stringify(bad));
  }
});
