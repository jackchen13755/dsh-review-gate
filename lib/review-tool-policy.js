/**
 * 子 Agent 守卫：**指向「代码审查工程师」的召唤只在主会话发起**。
 *
 * 用户的明确要求（2026-11-10，2026-11-16 随评审入口变更沿用）：评审入口归主会话。
 *
 * 为什么这一层必须硬拦（不是写提示词）：
 *  `summon_expert("代码审查工程师", …)` 会在专家插件内起一个独立审查子 Agent，
 *  而审查子继承全局 `AGENTS.md` 的「开工先叫人 / 交付前跑一次评审」——它可能反过来
 *  再召唤同一个专家 → 再起审查子 → 成环（实测跑到 delegationDepth=4）。
 *  同时，子 Agent 的评审**不计入门禁证据**（gate 只认主会话的调用），所以放行它只会
 *  给子 Agent 一个「我评审过了」的错觉，最后仍被主会话打回。两件事都指向同一个动作：
 *  在召唤边界就把这个入口关掉，并给出可执行的替代路径。
 *
 * ⚠️ 守卫对象变了，别照旧读：旧版拦的是 `dsh_code_review` 工具名（该工具 2026-11-16
 * 随第三方插件卸载，再拦它等于拦一个不存在的名字——死逻辑）。现在拦的是
 * `summon_expert` / `summon_experts` **且** `expert` 参数指向代码审查工程师的调用。
 * 只拦「叫审查工程师」，**不拦**「叫别的专家」：`summon_expert("UI 设计师")` 在子 Agent
 * 里完全合法（有单测钉住），否则队友就再也叫不到任何专家了。
 *
 * 判据用 `origin` + `delegationDepth` 双通道，不认 label / 名字：
 *   · label 随 locale 变、实测还撞名，不能作为身份依据；
 *   · 只用 origin 会漏掉「会话分叉」形态（有 parentSession、无 origin，宿主明确
 *     把它算独立会话），而门禁侧 gate.js 用的是 delegationDepth —— 两侧判据不同源
 *     就会出现「一边认为它该评、另一边认为它是子会话」的空档。这里把两条都收进来。
 *
 * 失败方向必须写清：**看不到 arguments 时一律放行**（无法证明它叫的是审查工程师，
 * 宁可漏拦一次，也不能因为宿主没暴露参数就把所有专家调用都拒掉）。
 *
 * 纯函数，便于喂边界输入单测。
 */

import { REVIEW_EXPERT_DISPLAY_NAME, isReviewExpert, isReviewToolName } from './review-expert.js';

/** 被守卫的工具名（共享工具：只拦「叫审查工程师」的那部分调用）。 */
export const GUARDED_TOOL_NAMES = Object.freeze(['summon_expert', 'summon_experts']);

/** 拒绝理由（稳定串，可 grep 取证）。 */
export const SUBAGENT_REFUSAL = 'recursion-cut: 「代码审查工程师」评审只允许由主会话发起（子 Agent 的评审不计入门禁证据）。请把改动、验收命令与结论交回主会话，由主会话调用 summon_expert 评审后再收工。';

/**
 * 从 guard 拿到的 `exec` 里读出「这次召唤了谁」。
 *
 * guard 与 `tools/pre-execute` 拿的是同一个 execution 对象（宿主侧
 * `registerGuard: (context, guard) => context.tools.guard(guard)`），所以 `arguments`
 * 是**已解析的对象**；但历史版本/适配层也可能给 JSON 字符串，两种都收。
 * 形状不认识 → 返回空数组 → 不拦（见文件头的失败方向说明）。
 */
export function expertNamesOfExecution(exec) {
  if (exec === null || typeof exec !== 'object') return [];
  const raw = exec.arguments ?? exec.params ?? exec.args ?? exec.input;
  let args = raw;
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (args === null || typeof args !== 'object') return [];
  const out = [];
  if (typeof args.expert === 'string') out.push(args.expert);
  if (Array.isArray(args.experts)) {
    for (const item of args.experts) {
      if (typeof item === 'string') out.push(item);
      else if (item !== null && typeof item === 'object' && typeof item.expert === 'string') out.push(item.expert);
    }
  }
  return out;
}

/**
 * @param {{ name?: unknown, arguments?: unknown, origin?: unknown, depth?: unknown }} input
 *   name      —— 即将执行的工具名
 *   arguments —— 该次调用的参数（用来判断点名的专家是谁）
 *   origin    —— SessionHeader.origin（主会话为 undefined）
 *   depth     —— SessionHeader.delegationDepth（主会话缺省，子会话 > 0）
 * @returns {{ deny: boolean, reason?: string }}
 */
export function decideToolUse(input) {
  if (!isReviewToolName(input?.name)) return { deny: false };
  // 共享工具：先确认这次调用真的点名了审查工程师，否则一律放行。
  const targetsReviewer = expertNamesOfExecution(input).some((name) => isReviewExpert(name));
  if (!targetsReviewer) return { deny: false };
  const origin = input?.origin;
  const depth = typeof input?.depth === 'number' && Number.isFinite(input.depth) ? input.depth : 0;
  // 任一通道表明「这是被委派的会话」即拒绝：origin 认子 Agent，depth 认分叉/嵌套。
  if (origin === 'subagent' || depth > 0) return { deny: true, reason: SUBAGENT_REFUSAL };
  return { deny: false };
}

/** 这条拒绝理由里点名的专家（供日志/文档取用，避免文案两处漂移）。 */
export const GUARDED_EXPERT = REVIEW_EXPERT_DISPLAY_NAME;
