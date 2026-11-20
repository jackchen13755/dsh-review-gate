/**
 * 判决层：把几个信号合成「本轮是否已评审」。
 *
 * 纯函数——不读文件、不跑 git。所有取证在外面做完，这里只做组合，
 * 这样每一种「谎报」都能用合成输入单测钉住。
 *
 * 条件（全过才算已评审）：
 *  1. callSeen        本回合真的把改动交给了「代码审查工程师」专家（session 日志里的
 *                     tool/call，宿主写的事实，不可伪造；「认人」的判据在 lib/review-expert.js）
 *  2. resultOk        那次调用没有失败
 *  3. journalVerdict  旧第三方 journal 若存在则不能是 reject（交叉校验，防 finished-but-failed）
 *  4. digestFresh     评审之后没有再改代码（自算摘要比对）
 *  5. requiresLens    结构性改动还要求本回合跑过 lens（见 REASON_TEXT['no-lens']）
 *
 * `callSeen` 只回答「本回合有没有一次被接受的专家评审调用」，**不回答**「评审质量」。
 */

import { isAggregateVerdict } from './jury.js';

/**
 * @param {{
 *   eventsAvailable?: boolean,
 *   callSeen?: boolean,
 *   resultOk?: true|false|null,
 *   journalVerdict?: 'accept'|'reject'|'unknown',
 *   digestFresh?: true|false|undefined,
 *   reviewTool?: string|null,
 *   reviewToolAvailable?: boolean|undefined,
 *   jury?: { verdict?: string }|null,
 *   juryRequired?: boolean,
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
    jury = undefined,
    juryRequired = false,
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

  // 到这里为止，「评审证据是谁」已经在取证层定死（lib/review-expert.js）：
  // 只有主会话 summon_expert/summon_experts 点名「代码审查工程师」才算，别的一律不算。
  // 所以这一层不再有「自审顶替独立评审」这条分支，也没有第二个候选工具。
  //
  // 陪审团（M5，默认关闭）：只有调用方显式 juryRequired=true 时才参与，而且只做**加法**——
  // 上面所有拒绝路径已经 return，能走到这里就说明「既有判定通过」。
  // 通过条件 = 既有判定通过 ∧ 陪审团 verdict === 'pass'；
  // fail / topped / unclear / unavailable 一律不放行，且原因分开（便于对账既有拒绝路径）。
  // juryRequired 不为 true 时**不读 jury、不改返回值**：旧调用的行为逐字段不变。
  if (juryRequired !== true) return { reviewed: true, reason: 'ok' };
  const juryVerdict = juryVerdictOf(jury);
  if (juryVerdict === 'pass') return { reviewed: true, reason: 'ok' };
  if (juryVerdict === 'fail') return { reviewed: false, reason: 'jury-fail' };
  if (juryVerdict === 'topped') return { reviewed: false, reason: 'jury-topped' };
  if (juryVerdict === 'unclear') return { reviewed: false, reason: 'jury-unclear' };
  return { reviewed: false, reason: 'jury-unavailable' };
}

/**
 * 把 jury 信号收敛成聚合判决。
 *
 * **只认聚合结果对象**（`{ verdict }`，即 aggregateVotes / aggregateJuryForGate 的返回）：
 * 不接受裸字符串，因为「一句 'pass'」没有票数、没有门槛、没有边界信息，
 * 收下它等于给调用方留一条绕过三席齐备的捷径。任何不认识的值 → 'unavailable'：
 * 读不懂票型不能当通过。
 */
function juryVerdictOf(jury) {
  const verdict = jury && typeof jury === 'object' ? jury.verdict : undefined;
  return isAggregateVerdict(verdict) ? verdict : 'unavailable';
}

/** 判决原因 → 给人看的一句解释（进日志与 status 工具）。 */
export const REASON_TEXT = Object.freeze({
  'no-call': '本回合没有让「代码审查工程师」专家评审（只有主会话 summon_expert/summon_experts 点名该专家才算）',
  'call-unresolved': '派发了专家评审但本回合没有它的结果（调用未完成），不能算已评审',
  'call-failed': '派发了专家评审，但那次 summon_expert / summon_experts 调用失败',
  'no-lens': '结构性改动（新增/删除代码文件）没有跑 lens 看影响面与循环依赖',
  'journal-rejected': '评审 journal 的最终状态不是通过（如 failed / interrupted / stale）',
  stale: '评审之后又改动了代码，评审未覆盖当前这版 diff',
  'jury-fail': '陪审团多数票 fail：评审结论是不通过',
  'jury-topped': '陪审团被「边界外缺口」顶住（≥2 票 insufficient 且 boundary=external）：不适用多数决，不放行',
  'jury-unclear': '陪审团无法形成多数（含全部 undecidable）：判不了就不放行',
  'jury-unavailable': '陪审团没有有效票型（票不足 / 通道不可用）：没投票不等于通过',
  ok: '已评审且覆盖当前 diff',
  'undetermined-events': '拿不到会话事件源，无法判定（已放行）',
});
