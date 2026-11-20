/**
 * 票的证据绑定（P0）：一张票必须指认一个**本会话内可核验的事实**。
 *
 * 为什么必须有这一层：`jury_vote` 如果只校验枚举，模型连调三次就得到了三张「票」，
 * 与真的走三遍评审在门禁眼里完全一样——`requireJury` 就退化成一句装饰。
 * 证据必须是**模型编不出来**的东西：宿主写的 tool/call、本插件亲自跑出的 canary 回执、
 * 或本会话真实发生的写文件记录。
 *
 * 判据分两级：
 *  1. 结构级（lib/jury.js 的 normalizeBasis）：kind 合法、ref 非空；
 *  2. 事实级（本文件 verifyVoteBasis）：ref 能在事件流/回执/写记录里指认到。
 *
 * 这里只做「指认」，不做「够不够三票」——那是 aggregateJuryForGate 的事。
 */

import { eventsOf, findCalls, hostEmitsResults, resultOkFor } from './replay.js';
import { canaryReceiptOf, canaryStateOf, MUTANT_VERDICT } from './canary.js';
import { normalizeBasis } from './jury.js';
import { observedPaths } from './observed.js';
import { isReviewExpertCall, REVIEW_TOOL_NAMES } from './review-expert.js';

/**
 * 本会话里「代码审查工程师」的调用事实：callId + 是否拿到成功结果。
 *
 * 用 `findCalls` + `isReviewExpertCall`，与门禁判「本轮是否已评审」**同一套判据**——
 * 两处各写一份必然漂移，一处放宽就出现「票指向一个门禁不承认的调用」。
 *
 * 宿主不记 tool/result 时（`hostEmitsResults === false`），"看到调用"就是能拿到的最强事实，
 * 这时按已指认处理；否则必须 resultOk === true（一次失败的调用不能当证据）。
 *
 * @param {any[]} events
 * @returns {{ callId: string, tool: string, ok: boolean }[]}
 */
/** 事件级时间戳（宿主可能给 `at`/`ts`，也可能完全不给）。 */
function eventAtOf(event) {
  for (const value of [event?.at, event?.data?.at, event?.ts, event?.data?.ts]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** 「同期判据退化为 fail-open」只告警一次（每回合都刷屏等于没告警）。 */
let warnedMissingTurn = false;

function warnMissingTurnOnce() {
  if (warnedMissingTurn) return;
  warnedMissingTurn = true;
  console.warn(
    '[dsh-review-gate] 宿主没有提供可比的 turn/时间戳：jury 的「expert 证据必须与本版 diff 同期」'
    + '判据退化为接受（fail-open）。「pass 只认 expert」与「三票指认三个不同事实」不受影响。',
  );
}

/** 测试用：清掉「已告警」标记。 */
export function resetJuryBasisWarningsForTests() {
  warnedMissingTurn = false;
}

/**
 * 本会话里「代码审查工程师」的调用事实：callId + 是否拿到成功结果 + 回合/时刻。
 *
 * turn 用于「依据必须与这版 diff 同期」（P1-2）；宿主不记 turn 时退化为事件时间戳 `at`。
 * 两者都没有时由 verifyVoteBasis 决定 fail-open（并 warn 一次），而不是把整条 jury 判死。
 */
export function expertCallEvidence(events) {
  const list = Array.isArray(events) ? events : [];
  const emitsResults = hostEmitsResults(list);
  const atById = new Map();
  for (const event of list) {
    if (!event || event.type !== 'tool/call') continue;
    const id = event.data && event.data.callId;
    if (typeof id !== 'string' || id === '') continue;
    const at = eventAtOf(event);
    if (typeof at === 'number') atById.set(id, at);
  }
  return findCalls(list, { toolNames: REVIEW_TOOL_NAMES, match: isReviewExpertCall }).map((call) => {
    const result = resultOkFor(list, call.callId);
    const ok = result === true || (result === null && emitsResults === false);
    const evidence = { callId: call.callId, tool: call.name, ok, turn: call.turn };
    const at = atById.get(call.callId);
    if (typeof at === 'number') evidence.at = at;
    return evidence;
  });
}

/** 本会话变异检定回执里**被杀死的具名变异体**（canary 类证据要能指认到其中一个）。 */
export function canaryKilledIds(receipt) {
  if (!receipt || typeof receipt !== 'object' || !Array.isArray(receipt.mutants)) return [];
  return receipt.mutants
    .filter((m) => m && (m.verdict === MUTANT_VERDICT.KILLED_BY_ASSERTION || m.killed === true))
    .map((m) => String(m.id ?? ''))
    .filter((id) => id !== '');
}

function normalizeFileRef(ref) {
  let out = String(ref).replace(/\\/g, '/').trim();
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * ref 是否指认到某个已观察到的写入路径。
 *
 * 观察记录存的是**绝对路径**，而调用方通常写仓库相对路径（`lib/jury.js`），
 * 所以允许「绝对路径以 /<ref> 结尾」这一种等价。不做模糊匹配（basename 撞车会把
 * `a/x.js` 与 `b/x.js` 混为一谈）。
 */
export function fileRefMatches(observedPath, ref) {
  const left = normalizeFileRef(observedPath);
  const right = normalizeFileRef(ref);
  if (left === '' || right === '') return false;
  if (left === right) return true;
  // 只接受**带目录的相对路径**作为后缀（`lib/a.js` → `/repo/lib/a.js`）。
  // 裸 basename（`x.js`）不做匹配：`a/x.js` 与 `b/x.js` 的 basename 相同，
  // 模糊匹配会让一张票指认到一条根本没被写过的路径，等于没绑证据。
  if (!right.includes('/')) return false;
  return left.endsWith(`/${right}`);
}

/**
 * 校验一张票的 basis 能不能在本会话的事实里指认到。
 *
 * @param {unknown} basis
 * @param {{ expertCalls?: {callId:string, ok:boolean}[], canary?: {state?:string, killed?:string[]}, files?: string[] }} [ctx]
 * @returns {{ ok: true, basis: { kind: string, ref: string } } | { ok: false, reason: string }}
 */
export function verifyVoteBasis(basis, ctx = {}) {
  const normalized = normalizeBasis(basis);
  if (!normalized.ok) return normalized;
  const { kind, ref } = normalized.basis;

  if (kind === 'expert') {
    const calls = Array.isArray(ctx.expertCalls) ? ctx.expertCalls : [];
    if (calls.length === 0) {
      return { ok: false, reason: '本会话事件流里没有可指认的「代码审查工程师」调用（先评审，再投票）' };
    }
    const hit = calls.find((call) => call && call.callId === ref);
    if (!hit) {
      return { ok: false, reason: `basis.ref=${ref} 在本会话事件流里找不到对应的专家调用` };
    }
    if (hit.ok !== true) {
      return { ok: false, reason: `basis.ref=${ref} 的那次专家调用没有成功结果，不能当证据` };
    }
    // P1-2：依据必须与这版 diff 同期。门禁把「这版 diff **首次**被观察到的回合/时刻」
    // 记为 minTurn / minAt；更早的调用属于上一版 diff，不能给这一版投票。
    //
    // 退化链（fail-open 只影响这一条同期判据，不影响「pass 只认 expert」的主闸）：
    //   turn 可比 → 比 turn；turn 缺失 → 比事件时间戳 at；都没有 → 接受 + warn 一次。
    // 为什么不能直接拒：宿主不记 tool/call.turn 时，requireJury 会变成永远无法满足的要求，
    // 那是「拦死」而不是「误放行」，比漏一次同期判据更糟。
    if (typeof hit.turn === 'number' && typeof ctx.minTurn === 'number') {
      if (hit.turn < ctx.minTurn) {
        return {
          ok: false,
          reason: `basis.ref=${ref} 的专家调用发生在更早的回合（turn ${hit.turn} < 当前取证回合 ${ctx.minTurn}），`
            + '属于上一版 diff，不能给这一版投票',
        };
      }
      return { ok: true, basis: normalized.basis };
    }
    if (typeof hit.at === 'number' && typeof ctx.minAt === 'number') {
      if (hit.at < ctx.minAt) {
        return {
          ok: false,
          reason: `basis.ref=${ref} 的专家调用早于这版 diff 首次被观察到的时刻，属于上一版 diff，不能给这一版投票`,
        };
      }
      return { ok: true, basis: normalized.basis };
    }
    if (typeof ctx.minTurn === 'number' || typeof ctx.minAt === 'number') {
      warnMissingTurnOnce();
    }
    return { ok: true, basis: normalized.basis };
  }

  if (kind === 'canary') {
    const state = ctx.canary && typeof ctx.canary === 'object' ? ctx.canary.state : undefined;
    if (state !== 'verified') {
      return { ok: false, reason: `本会话没有 verified 的变异检定回执（当前 ${state ?? 'unknown'}），canary 类证据无法指认` };
    }
    const killed = Array.isArray(ctx.canary.killed) ? ctx.canary.killed : [];
    if (ref === 'verified' || killed.includes(ref)) return { ok: true, basis: normalized.basis };
    return { ok: false, reason: `basis.ref=${ref} 不在回执的 killed 变异体列表里` };
  }

  // kind === 'file'
  const files = Array.isArray(ctx.files) ? ctx.files : [];
  if (files.length === 0) {
    return { ok: false, reason: '本会话没有观察到写文件记录，file 类证据无法指认' };
  }
  if (!files.some((file) => fileRefMatches(file, ref))) {
    return { ok: false, reason: `basis.ref=${ref} 不是本会话写过的文件` };
  }
  return { ok: true, basis: normalized.basis };
}

/**
 * 从当前会话收集 basis 校验需要的三处事实。
 *
 * deps 仅供单测注入（events / files）；生产路径全部走真实来源。
 */
export function juryBasisContextOf({ agent, sessionId, deps = {} } = {}) {
  const ev = deps.events ?? eventsOf(agent?.session);
  const events = Array.isArray(ev.events) ? ev.events : [];
  const files = typeof deps.files === 'function' ? deps.files(sessionId) : observedPaths(sessionId);
  const receipt = typeof deps.canaryReceipt === 'function' ? deps.canaryReceipt(sessionId) : canaryReceiptOf(sessionId);
  return {
    eventsAvailable: ev.available !== false,
    // 当前这版 diff **首次**被观察到的回合/时刻：expert 类证据必须发生在其后（P1-2）。
    minTurn: typeof deps.minTurn === 'number' ? deps.minTurn : undefined,
    minAt: typeof deps.minAt === 'number' ? deps.minAt : undefined,
    expertCalls: expertCallEvidence(events),
    canary: {
      state: typeof deps.canaryState === 'function' ? deps.canaryState(sessionId) : canaryStateOf(sessionId),
      killed: canaryKilledIds(receipt),
    },
    files,
  };
}
