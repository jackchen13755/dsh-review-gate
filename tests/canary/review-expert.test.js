/**
 * 真实仓库上的 canary 断言：评审证据判据（谁算「代码审查工程师」）必须能红。
 *
 * 为什么这两条要单独进 tests/canary/：mutants.json 里的变异体是按
 * `baselineCmd`（`node --test tests/canary/`）跑的，只有在这一套里的具名断言
 * 才会被变异检定看见。主测试集里的同款断言不在这个基线内。
 *
 * 正反两半都要有：只钉「审查工程师算」的话，把判据放宽成「任何专家都算」
 * （甚至 `return true`）依然全绿 —— 那就只锁了半扇门。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isReviewExpert, isReviewExpertCall } from '../../lib/review-expert.js';

const call = (name, args) => ({ name, arguments: JSON.stringify(args) });
const reviewerArgs = { expert: '代码审查工程师', task: '审查改动' };

test('反向：不是审查工程师的专家不算评审证据 @canary id=review-expert.alias-match', () => {
  assert.equal(isReviewExpert('UI 设计师'), false, 'UI 设计师 不是审查工程师');
  assert.equal(isReviewExpert('代码审查工程师助理'), false, '名字里带那几个字不等于就是它');
  assert.equal(isReviewExpertCall(call('summon_expert', { expert: 'UI 设计师' })), false, '叫别的专家不算评审');
});

test('正向：审查工程师的中文名与 slug 必须被认出来 @canary id=review-expert.alias-match', () => {
  assert.equal(isReviewExpert('代码审查工程师'), true);
  assert.equal(isReviewExpert('engineering-code-reviewer'), true);
  assert.equal(isReviewExpertCall(call('summon_expert', reviewerArgs)), true, '中文名必须算证据');
});

test('工具名反向：非召唤工具 / 相似名字传同样参数不算评审 @canary id=review-expert.tool-name', () => {
  assert.equal(isReviewExpertCall(call('bash', reviewerArgs)), false, '别的工具传同样参数不能冒充评审');
  assert.equal(isReviewExpertCall(call('summon_expert_v2', reviewerArgs)), false, '相似工具名不该被认成 summon_expert');
  assert.equal(isReviewExpertCall(call('summon_expert', reviewerArgs)), true, '正向对照：真入口必须算');
});
