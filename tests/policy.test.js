import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  GUARDED_TOOL_NAMES,
  SUBAGENT_REFUSAL,
  decideToolUse,
  expertNamesOfExecution,
} from '../lib/review-tool-policy.js'

/**
 * 子 Agent 守卫（2026-11-16 起的新对象）。
 *
 * 守卫拦的是「召唤**代码审查工程师**」这一种调用，不是整个 summon 工具：
 * 队友还得能叫别的专家。所以每条反向断言都配一条正向断言——
 * 只验「没误杀」或只验「拦住了」都只锁半扇门。
 */

const reviewer = { expert: '代码审查工程师', task: '审查未提交的更改' }
const reviewerSlug = { expert: 'engineering-code-reviewer', task: '审查改动' }
const designer = { expert: 'UI 设计师', task: '看设计稿' }
const batchWithReviewer = { experts: [{ expert: 'UI 设计师' }, { expert: 'code-reviewer' }] }
const batchDesignerOnly = { experts: [{ expert: 'UI 设计师' }, { expert: '软件架构师' }] }

test('守卫工具面就是 summon_expert / summon_experts（不再拦一个已不存在的工具名）', () => {
  assert.deepEqual([...GUARDED_TOOL_NAMES], ['summon_expert', 'summon_experts'])
})

test('主会话（origin 缺失 / 0 depth）召唤审查工程师放行', () => {
  for (const origin of [undefined, null, 'user', '']) {
    const v = decideToolUse({ name: 'summon_expert', arguments: reviewer, origin })
    assert.equal(v.deny, false, `origin=${String(origin)} 应视为主会话`)
  }
  assert.equal(decideToolUse({ name: 'summon_expert', arguments: reviewer, depth: 0 }).deny, false)
})

test('子 Agent 召唤审查工程师被拒，理由可 grep 且说了下一步', () => {
  const v = decideToolUse({ name: 'summon_expert', arguments: reviewer, origin: 'subagent' })
  assert.equal(v.deny, true)
  assert.equal(v.reason, SUBAGENT_REFUSAL)
  assert.match(v.reason, /^recursion-cut: /)
  assert.match(v.reason, /交回主会话/, '拒绝理由必须给出替代路径，否则子 Agent 只会反复撞墙')
})

test('子 Agent 召唤别的专家照常放行（不然队友再也叫不到任何专家）', () => {
  for (const args of [designer, batchDesignerOnly]) {
    for (const name of GUARDED_TOOL_NAMES) {
      assert.equal(
        decideToolUse({ name, arguments: args, origin: 'subagent' }).deny,
        false,
        `${name} + 非审查专家不该被拦`,
      )
    }
  }
})

test('批量召唤里含审查工程师 → 拒（批量不能绕过守卫）', () => {
  for (const origin of ['subagent']) {
    assert.equal(decideToolUse({ name: 'summon_experts', arguments: batchWithReviewer, origin }).deny, true)
  }
  assert.equal(decideToolUse({ name: 'summon_experts', arguments: batchWithReviewer, depth: 2 }).deny, true)
})

test('expert 的三种写法都被认出（中文名 / 全 slug / 简 slug）', () => {
  for (const args of [reviewer, reviewerSlug, { expert: 'code-reviewer' }, { expert: ' engineering/code-reviewer ' }]) {
    assert.equal(
      decideToolUse({ name: 'summon_expert', arguments: args, origin: 'subagent' }).deny,
      true,
      JSON.stringify(args),
    )
  }
})

test('边界输入：工具名 undefined / null / 空串 / 非字符串一律放行且不抛', () => {
  for (const name of [undefined, null, '', 42, {}, []]) {
    assert.equal(decideToolUse({ name, arguments: reviewer, origin: 'subagent' }).deny, false)
  }
})

test('边界输入：input 整体为 undefined 也不抛', () => {
  assert.equal(decideToolUse(undefined).deny, false)
  assert.equal(decideToolUse().deny, false)
})

test('其它工具在子 Agent 里照常放行（这条规则只管 summon）', () => {
  for (const name of ['bash', 'read', 'lens', 'edit', 'subagent']) {
    assert.equal(decideToolUse({ name, arguments: reviewer, origin: 'subagent' }).deny, false)
  }
})

test('名字相似的工具不误伤：summon_expert_v2 / summon_experts_backup 继续放行', () => {
  for (const name of ['summon_expert_v2', 'summon_experts_backup', 'xsummon_expert']) {
    assert.equal(decideToolUse({ name, arguments: reviewer, origin: 'subagent' }).deny, false, name)
  }
})

test('命名空间化的同一工具在子 Agent 里同样被拒（不能靠改名绕过）', () => {
  for (const name of ['mcp__dsh__summon_expert', 'x__summon_experts']) {
    assert.equal(decideToolUse({ name, arguments: reviewer, origin: 'subagent' }).deny, true, name)
  }
})

test('会话分叉形态（无 origin 但有 delegationDepth>0）也拒绝', () => {
  assert.equal(decideToolUse({ name: 'summon_expert', arguments: reviewer, depth: 1 }).deny, true)
  assert.equal(decideToolUse({ name: 'summon_expert', arguments: reviewer, depth: 4 }).deny, true)
  assert.equal(decideToolUse({ name: 'summon_expert', arguments: reviewer }).deny, false)
})

test('边界输入：depth 非数字/NaN 一律按主会话处理，不抛', () => {
  for (const depth of [undefined, null, '2', NaN, {}, []]) {
    assert.equal(decideToolUse({ name: 'summon_expert', arguments: reviewer, depth }).deny, false, String(depth))
  }
})

test('看不到 arguments 时一律放行（宁可漏拦一次，也不能误杀所有专家调用）', () => {
  for (const args of [undefined, null, '', '{坏 JSON', 42, true, []]) {
    assert.equal(
      decideToolUse({ name: 'summon_expert', arguments: args, origin: 'subagent' }).deny,
      false,
      `arguments=${JSON.stringify(args)} 无法证明叫的是审查工程师 → 不能拦`,
    )
  }
})

test('expert 值非字符串 / 空串 / 纯空白 → 不算审查工程师', () => {
  for (const expert of [undefined, null, '', '   ', 42, {}, ['代码审查工程师']]) {
    assert.equal(
      decideToolUse({ name: 'summon_expert', arguments: { expert }, origin: 'subagent' }).deny,
      false,
      String(expert),
    )
  }
})

test('expertNamesOfExecution：对象 / JSON 字符串 / 批量 / 裸字符串元素都要解析', () => {
  assert.deepEqual(expertNamesOfExecution({ arguments: reviewer }), ['代码审查工程师'])
  assert.deepEqual(expertNamesOfExecution({ arguments: JSON.stringify(reviewer) }), ['代码审查工程师'])
  assert.deepEqual(
    expertNamesOfExecution({ arguments: { experts: ['代码审查工程师', { expert: 'UI 设计师' }] } }),
    ['代码审查工程师', 'UI 设计师'],
  )
  // 兜底键位（宿主/适配层可能叫 params / args / input）
  assert.deepEqual(expertNamesOfExecution({ params: reviewer }), ['代码审查工程师'])
  assert.deepEqual(expertNamesOfExecution({ args: JSON.stringify(reviewer) }), ['代码审查工程师'])
  assert.deepEqual(expertNamesOfExecution({ input: reviewer }), ['代码审查工程师'])
  // 读不出来一律空数组
  assert.deepEqual(expertNamesOfExecution(undefined), [])
  assert.deepEqual(expertNamesOfExecution({}), [])
  assert.deepEqual(expertNamesOfExecution({ arguments: '{坏' }), [])
})

test('名字里带「代码审查工程师」但不是它的专家不误伤（精确别名，不做子串匹配）', () => {
  for (const expert of ['代码审查工程师助理', '代码审查工程师-2', 'engineering-code-reviewer-x']) {
    assert.equal(
      decideToolUse({ name: 'summon_expert', arguments: { expert }, origin: 'subagent' }).deny,
      false,
      `${expert} 不是代码审查工程师`,
    )
  }
})
