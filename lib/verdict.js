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
 */

/**
 * @param {{
 *   eventsAvailable?: boolean,
 *   callSeen?: boolean,
 *   resultOk?: true|false|null,
 *   journalVerdict?: 'accept'|'reject'|'unknown',
 *   digestFresh?: true|false|undefined,
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
  } = signals;

  // 事件源拿不到：无法判定，按 fail-open 放行（否则这类宿主永远收不了工）。
  if (eventsAvailable === false) return { reviewed: true, reason: 'undetermined-events' };

  if (callSeen !== true) {
    // 派发了但拿不到结果（且宿主是会记结果的）→ 这次调用没完成，不是「没调用」。
    // 区分这两者的意义：前者该等结果，后者该去评审；提示语不同，排查方向也不同。
    return { reviewed: false, reason: callUnresolved === true ? 'call-unresolved' : 'no-call' };
  }
  if (resultOk === false) return { reviewed: false, reason: 'call-failed' };
  // 结构性改动（新增/删除代码文件）除了评审，还要求跑过 lens：
  // 「模块划分是否合理」从单个文件里看不出来，只能从依赖图上看。
  if (requiresLens === true && lensSeen !== true) return { reviewed: false, reason: 'no-lens' };
  if (journalVerdict === 'reject') return { reviewed: false, reason: 'journal-rejected' };
  if (digestFresh === false) return { reviewed: false, reason: 'stale' };

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
