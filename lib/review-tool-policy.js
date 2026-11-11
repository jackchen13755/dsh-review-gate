/**
 * 评审工具的唯一入口，以及「子 Agent 不可用」的执行策略。
 *
 * 用户的明确要求（2026-11-10，2026-11-11 再次确认）：
 *   · 评审统一用 `dsh_code_review`；
 *   · **这个工具不可以在子 agent 里面使用**（否则「评审里触发评审」= 无限循环）。
 *
 * 为什么要在这一层硬拦：`dsh_code_review` 会 spawn 一个独立审查子 Agent，而审查子
 * 会继承全局 AGENTS.md 的「开工先叫人」，于是可能反过来召唤 Agency 专家；专家又
 * 被告知「交付前跑一次评审」→ 再起审查子 → 成环（实测跑到 delegationDepth=4）。
 * 把 `dsh_code_review` 限制在主会话，环的闭合边就不存在了。
 *
 * ⚠️ 状态变更（2026-11-11）：本守卫**曾经休眠**——上游 1.0.9+ 把工具改成 /review
 * 斜杠命令、不再注册任何工具，于是它「不会命中任何调用」。自研 fork 在 2026-11-11
 * 重新注册了该工具（用户要求让 agent 也能触发评审），**这段守卫因此重新生效**，
 * 是递归环的第一道闸门，不再是死代码。判定本身仍有单测钉住。
 *
 * 判据用 `origin` + `delegationDepth` 双通道，不认 label / 名字：
 *   · label 随 locale 变、实测还撞名，不能作为身份依据；
 *   · 只用 origin 会漏掉「会话分叉」形态（有 parentSession、无 origin，宿主明确
 *     把它算独立会话），而门禁侧 gate.js 用的是 delegationDepth —— 两侧判据不同源
 *     就会出现「一边认为它该评、另一边认为它是子会话」的空档。这里把两条都收进来。
 *
 * 纯函数，便于喂边界输入单测。
 */

/** 唯一被接受的评审工具。 */
export const REVIEW_TOOL = 'dsh_code_review'

/**
 * 命名空间化后的同一工具（如 MCP 前缀 `mcp__x__dsh_code_review`）。
 *
 * 只放行「整名相等」或「`__` 分隔后的末段相等」，刻意**不用**子串包含：
 * `dsh_code_review_x` 这类以本名开头的其它工具必须继续放行（有单测钉住），
 * 用 includes() 会把它误拦。
 */
const NAMESPACED_REVIEW_TOOL = /(?:^|__)dsh_code_review$/

/** 拒绝理由（稳定串，可 grep 取证）。 */
export const SUBAGENT_REFUSAL = 'recursion-cut: dsh_code_review 只允许在主会话调用（子 Agent 不可用）。请把改动与结论交回主会话，由主会话评审后再收工。'

function isReviewToolName(name) {
  if (typeof name !== 'string' || name === '') return false
  return NAMESPACED_REVIEW_TOOL.test(name)
}

/**
 * @param {{ name?: unknown, origin?: unknown, depth?: unknown }} input
 *   name   —— 即将执行的工具名
 *   origin —— SessionHeader.origin（主会话为 undefined）
 *   depth  —— SessionHeader.delegationDepth（主会话缺省，子会话 > 0）
 * @returns {{ deny: boolean, reason?: string }}
 */
export function decideToolUse(input) {
  if (!isReviewToolName(input?.name)) return { deny: false }
  const origin = input?.origin
  const depth = typeof input?.depth === 'number' && Number.isFinite(input.depth) ? input.depth : 0
  // 任一通道表明「这是被委派的会话」即拒绝：origin 认子 Agent，depth 认分叉/嵌套。
  if (origin === 'subagent' || depth > 0) return { deny: true, reason: SUBAGENT_REFUSAL }
  return { deny: false }
}
