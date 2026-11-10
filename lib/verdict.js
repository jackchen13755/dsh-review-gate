/**
 * 判决层：把四个信号合成「本轮是否已评审」。
 *
 * 纯函数——不读文件、不跑 git。所有取证在外面做完，这里只做组合，
 * 这样每一种「谎报」都能用合成输入单测钉住。
 *
 * 四个条件（全过才算已评审）：
 *  1. callSeen        本回合真的调过 dsh_code_review（宿主写的事实，不可伪造）
 *  2. resultOk        那次调用没有失败
 *  3. journalVerdict  第三方 journal 若存在则不能是 reject（交叉校验，防 finished-but-failed）
 *  4. digestFresh     评审之后没有再把代码改掉（自算摘要比对）
 *
 * 第五个条件（工具身份）单列在最后：callSeen 只回答「调过评审工具」，不回答
 * 「调的是不是那个独立的」。现在评审工具只有一个（dsh_code_review），所以这一层
 * 只剩占位：保留参数以免调用方大改，判定不再有第二个候选。
 */

/**
 * @param {{
 *   eventsAvailable?: boolean,
 *   callSeen?: boolean,
 *   resultOk?: true|false|null,
 *   journalVerdict?: 'accept'|'reject'|'unknown',
 *   digestFresh?: true|false|undefined,
 *   reviewTool?: string|null,
 *   reviewToolAvailable?: boolean|undefined,
 * }} signals
 * @returns {{ reviewed: boolean, reason: string }}
 */
export function decideReview(signals = {}) {
  const {
    eventsAvailable = true,
    callSeen = false,
    resultOk = null,
    journalVerdict = 'unknown',
    digestFresh = undefined,
    requiresLens = false,
    lensSeen = false,
    callUnresolved = false,
    reviewTool = null,
    reviewToolAvailable = undefined,
  } = signals;

  // 事件源拿不到：无法判定，按 fail-open 放行（否则这类宿主永远收不了工）。
  if (eventsAvailable === false) return { reviewed: true, reason: 'undetermined-events' };

  // 失败必须排在「没调用」之前：replay 里一次明确失败的调用不会置 callSeen，
  // 所以 callSeen=false 既可能是「真没调」也可能是「调了但失败」。报「没调用」
  // 会把排查方向带偏（让人去重跑一次评审），而真实原因是那次调用挂了。
  if (resultOk === false) return { reviewed: false, reason: 'call-failed' };

  if (callSeen !== true) {
    // 派发了但拿不到结果（且宿主是会记结果的）→ 这次调用没完成，不是「没调用」。
    // 区分这两者的意义：前者该等结果，后者该去评审；提示语不同，排查方向也不同。
    if (callUnresolved === true) return { reviewed: false, reason: 'call-unresolved' };
    // 有过一次评审、但当前 diff 已经变了、又没有更晚的调用 → 评审没覆盖这版改动。
    // 这时报 no-call 同样是误导：agent 会以为从没审过，实际是审完又改了。
    if (digestFresh === false) return { reviewed: false, reason: 'stale' };
    return { reviewed: false, reason: 'no-call' };
  }
  // 结构性改动（新增/删除代码文件）除了评审，还要求跑过 lens：
  // 「模块划分是否合理」从单个文件里看不出来，只能从依赖图上看。
  if (requiresLens === true && lensSeen !== true) return { reviewed: false, reason: 'no-lens' };
  if (journalVerdict === 'reject') return { reviewed: false, reason: 'journal-rejected' };
  // 第二个 stale 入口：callSeen 为真但摘要不新鲜，说明这次调用没覆盖当前 diff。
  // 与上面那个入口（callSeen 为假）是两条不同的控制路径，都要能到达。
  if (digestFresh === false) return { reviewed: false, reason: 'stale' };

  // 工具身份只剩一个候选：REVIEW_TOOLS 里只有 dsh_code_review（review_brief 已删），
  // 所以这一段不再有「自审顶替独立评审」的分支；历史原因保留参数签名。
  return { reviewed: true, reason: 'ok' };
}

/** 判决原因 → 给人看的一句解释（进日志与 status 工具）。 */
export const REASON_TEXT = Object.freeze({
  'no-call': '本回合没有调用 dsh_code_review',
  'call-unresolved': '派发了 dsh_code_review 但本回合没有它的结果（调用未完成），不能算已评审',
  'call-failed': '调用了 dsh_code_review 但该次调用失败',
  'no-lens': '结构性改动（新增/删除代码文件）没有跑 lens 看影响面与循环依赖',
  'journal-rejected': '评审 journal 的最终状态不是通过（如 failed / interrupted / stale）',
  stale: '评审之后又改动了代码，评审未覆盖当前这版 diff',
  ok: '已评审且覆盖当前 diff',
  'undetermined-events': '拿不到会话事件源，无法判定（已放行）',
});
