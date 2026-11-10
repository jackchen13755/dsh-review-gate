/**
 * 评审工具的唯一入口，以及「子 Agent 不可用」的执行策略。
 *
 * 用户的明确要求（2026-11-10）：
 *   · 评审统一用 @michengai/dsh-code-review 的 `dsh_code_review`；
 *   · **这个插件不可以在子 agent 里面使用**。
 *
 * 为什么要在这一层硬拦：`dsh_code_review` 会 spawn 一个独立审查子 Agent，而审查子
 * 会继承全局 AGENTS.md 的「开工先叫人」，于是可能反过来召唤 Agency 专家；专家又
 * 被告知「交付前跑一次评审」→ 再起审查子 → 成环（实测跑到 delegationDepth=4）。
 * 把 `dsh_code_review` 限制在主会话，环的闭合边就不存在了。
 *
 * ⚠️ 休眠状态（2026-11-10）：`@michengai/dsh-code-review` 1.0.9+ **不再注册任何工具**
 * （改成 /review 斜杠命令，模型无法自己调用），所以这段守卫当前不会命中任何调用。
 * 保留它是因为：① 装上仍可能命中旧版本（工具形态回归时立即生效）；② 它在主会话放行、
 * 只挡子 Agent，与「子 Agent 不参与评审」的契约方向一致。判定本身有单测钉住。
 *
 * 判据只用会话头（`origin`），不认 label / 名字：label 随 locale 变、实测还撞名。
 * 纯函数，便于喂边界输入单测。
 */

/** 唯一被接受的评审工具。 */
export const REVIEW_TOOL = 'dsh_code_review'

/** 拒绝理由（稳定串，可 grep 取证）。 */
export const SUBAGENT_REFUSAL = 'recursion-cut: dsh_code_review 只允许在主会话调用（子 Agent 不可用）。请把改动与结论交回主会话，由主会话评审后再收工。'

/**
 * @param {{ name?: unknown, origin?: unknown }} input
 *   name   —— 即将执行的工具名
 *   origin —— SessionHeader.origin（主会话为 undefined）
 * @returns {{ deny: boolean, reason?: string }}
 */
export function decideToolUse(input) {
  const name = input?.name
  const origin = input?.origin
  if (name !== REVIEW_TOOL) return { deny: false }
  // 主会话（以及任何 origin 不是 subagent 的会话）放行。
  if (origin !== 'subagent') return { deny: false }
  return { deny: true, reason: SUBAGENT_REFUSAL }
}
