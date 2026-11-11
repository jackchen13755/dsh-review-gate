import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REVIEW_TOOL, SUBAGENT_REFUSAL, decideToolUse } from '../lib/review-tool-policy.js'

test('主会话（origin 缺失）调用 dsh_code_review 放行', () => {
  for (const origin of [undefined, null, 'user']) {
    assert.equal(decideToolUse({ name: REVIEW_TOOL, origin }).deny, false)
  }
})

test('子 Agent（origin=subagent）调用 dsh_code_review 被拒，理由可 grep', () => {
  const v = decideToolUse({ name: REVIEW_TOOL, origin: 'subagent' })
  assert.equal(v.deny, true)
  assert.equal(v.reason, SUBAGENT_REFUSAL)
  assert.match(v.reason, /^recursion-cut: /)
})

test('边界输入：工具名 undefined / null / 空串 / 非字符串一律放行且不抛', () => {
  for (const name of [undefined, null, '', 42, {}, []]) {
    assert.equal(decideToolUse({ name, origin: 'subagent' }).deny, false)
  }
})

test('边界输入：input 整体为 undefined 也不抛', () => {
  assert.equal(decideToolUse(undefined).deny, false)
  assert.equal(decideToolUse().deny, false)
})

test('其它工具在子 Agent 里照常放行（这条规则只管评审工具）', () => {
  for (const name of ['bash', 'read', 'summon_expert', 'lens', 'dsh_code_review_x']) {
    assert.equal(decideToolUse({ name, origin: 'subagent' }).deny, false)
  }
})

test('合法值 + 非法值组合：同一次调用里 origin 非法不影响工具名判定', () => {
  assert.equal(decideToolUse({ name: REVIEW_TOOL, origin: '' }).deny, false, '空 origin 视为主会话')
  assert.equal(decideToolUse({ name: REVIEW_TOOL, origin: 'subagent' }).deny, true)
})

// 2026-11-11：工具重新注册后本守卫从「死代码」变回第一道闸门，因此把它的两个
// 已知盲区钉住——否则改名注册或会话分叉形态会静默绕过递归保护。
test('命名空间化的同一工具在子 Agent 里同样被拒（不能靠改名绕过）', () => {
  for (const name of ['mcp__dsh__dsh_code_review', 'x__dsh_code_review']) {
    assert.equal(decideToolUse({ name, origin: 'subagent' }).deny, true, name)
  }
  // 但以本名开头的其它工具必须继续放行（用 includes 会误伤）
  assert.equal(decideToolUse({ name: 'dsh_code_review_x', origin: 'subagent' }).deny, false)
  assert.equal(decideToolUse({ name: 'dsh_code_reviews', origin: 'subagent' }).deny, false)
})

test('会话分叉形态（无 origin 但有 delegationDepth>0）也拒绝', () => {
  // 宿主把 fork 当独立会话：有 parentSession、origin 缺失，只有 depth 能识别。
  assert.equal(decideToolUse({ name: REVIEW_TOOL, depth: 1 }).deny, true)
  assert.equal(decideToolUse({ name: REVIEW_TOOL, depth: 4 }).deny, true)
  // 主会话 depth 缺省/为 0 时放行
  assert.equal(decideToolUse({ name: REVIEW_TOOL, depth: 0 }).deny, false)
  assert.equal(decideToolUse({ name: REVIEW_TOOL }).deny, false)
})

test('边界输入：depth 非数字/NaN 一律按主会话处理，不抛', () => {
  for (const depth of [undefined, null, '2', NaN, {}, []]) {
    assert.equal(decideToolUse({ name: REVIEW_TOOL, depth }).deny, false, String(depth))
  }
})
