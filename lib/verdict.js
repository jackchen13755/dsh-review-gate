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
 * 「调的是不是那个独立的」。review_brief 同样是评审工具，但它把审查交给调用者自己，
 * 所以「本会话明明有 dsh_code_review 却用 review_brief 收工」判 weak-tool。
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

  // 自审不能顶替独立评审。review_brief 的契约写在 brief.js 首行：
  // 「审查由调用者自己完成」——它不是独立 reviewer，只是把准则与 diff 摆出来。
  //
  // 但它也不能一律拦：部分子会话根本不加载 dsh_code_review（专家子会话实测如此），
  // 那时它是唯一退路，拦了就会把人卡死。所以判据是「本会话有没有前者可用」：
  //   可用却仍用后者收工 → weak-tool（拦，让 agent 改用前者）
  //   不可用（或无法判定） → 放行，但结论必须标成 brief-self-review，不许与独立评审混同
  if (reviewTool === 'review_brief') {
    if (reviewToolAvailable === true) return { reviewed: false, reason: 'weak-tool' };
    return { reviewed: true, reason: 'brief-self-review' };
  }

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
  'weak-tool': '本会话有 dsh_code_review 却只用了 review_brief —— 后者是自审，不能顶替独立评审',
  'brief-self-review': '本会话没有 dsh_code_review，用 review_brief 自审后放行（已标注，非独立评审）',
  ok: '已评审且覆盖当前 diff',
  'undetermined-events': '拿不到会话事件源，无法判定（已放行）',
});
