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
