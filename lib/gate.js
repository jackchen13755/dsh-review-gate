/**
 * 门禁层：挂在 agent/turn-stopping 上，未评审则把 agent 拉回一步。
 *
 * 三条必须照做的既有约束（都是别人用真实故障换来的）：
 *  1. steer 消息的 source.kind 必须是**裸生产方名**（这里是 'review-gate'），
 *     不能写 'plugin'。v4 的 assertV4RowAdmission 会直接拒收 kind:'plugin'，
 *     而且拒收发生在 encodeEvent 阶段——即 agent.steer() 已经返回之后——
 *     所以你自己的 try/catch 吞不掉它，表现为「会话报错但磁盘上没有任何解释」。
 *  2. turn-stopping 是被 await 的串行检查点，必须 return promise，
 *     fire-and-forget 会和回合关闭赛跑，steer 直接丢失。
 *  3. 整个函数 try/catch 兜底返回 undefined——门禁自己坏掉绝不能把回合卡死。
 */

import { getConfig } from './config.js';
import { collectDiff } from './evidence.js';
import { readJournal } from './journal.js';
import { eventsOf, reviewCallInTurn } from './replay.js';
import { classifyTrigger } from './trigger.js';
import { decideReview, REASON_TEXT } from './verdict.js';

export const STEER_SOURCE_KIND = 'review-gate';
const TOOL_NAME = 'dsh_code_review';

/** 每个会话最近一次「通过评审」的 diff 摘要。 */
const reviewedDigest = new Map();
/** 每回合已催次数。 */
const turnSteers = new Map();
/** 每会话已催总额（必须有：payload.turn 缺失时只靠 turn 计数会被反复重置）。 */
const sessionSteers = new Map();
/** 最近一次判定的可观测状态，供 status 工具与变异测试读取。 */
const lastStatus = new Map();

function debug(...args) {
  if (getConfig().debug) console.log('[dsh-review-gate][debug]', ...args);
}

function sessionIdOf(agent) {
  const id = agent && typeof agent === 'object' ? agent.id : undefined;
  return typeof id === 'string' && id !== '' ? id : 'session';
}

function cwdOf(agent) {
  const header = agent?.session?.header;
  if (header && typeof header.cwd === 'string' && header.cwd !== '') return header.cwd;
  return process.cwd();
}

/** 子 agent 不单独拦（它的改动会进同一个 diff，主会话收尾已覆盖）。 */
function isSubagent(agent) {
  const depth = agent?.session?.header?.delegationDepth;
  return typeof depth === 'number' && depth > 0;
}

export function createSteerMessage(text) {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `review-gate-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: STEER_SOURCE_KIND },
  };
}

export function renderGateText(reasons, diff) {
  const where = reasons.length > 0 ? reasons.join('/') : '改动';
  const n = Array.isArray(diff.files) ? diff.files.length : 0;
  return (
    `review: 本回合改动命中 ${where}（${n} 个文件），收工前需要一次独立评审。\n`
    + `请调用 ${TOOL_NAME} 评审未提交的更改，例如：${TOOL_NAME}({ input: "审查未提交的更改" })\n`
    + '评审后不要再改代码——改了会重新触发。本条提示每回合最多 1 次。'
  );
}

async function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 处理回合结束。永不抛错；返回被 steer 的文本（供测试断言）。
 * @param {{ agent?: any, turn?: number }} payload
 * @param {{ collectDiff?: Function, readJournal?: Function }} [deps] 测试注入
 */
export async function handleTurnStopping(payload, deps = {}) {
  try {
    const cfg = getConfig();
    if (!cfg.gate) return undefined;

    const agent = payload?.agent;
    if (!agent || typeof agent.steer !== 'function') return undefined;
    if (isSubagent(agent) && !cfg.gateSubagents) return undefined;

    const sid = sessionIdOf(agent);
    const collect = deps.collectDiff ?? collectDiff;
    const readJ = deps.readJournal ?? readJournal;

    // ① 事件源
    const ev = eventsOf(agent.session);
    if (!ev.available) {
      debug('turn-stopping: 事件源不可得，放行', ev.source);
      return undefined;
    }

    // ② 当前 diff
    const diff = await withTimeout(collect(cwdOf(agent)), cfg.timeoutMs, { available: false, reason: 'timeout' });
    if (!diff || diff.available !== true) {
      debug('turn-stopping: diff 不可得，放行', diff?.reason);
      return undefined;
    }

    // ③ 这版 diff 是否已经评审过
    const rec = reviewedDigest.get(sid);
    if (rec && rec.digest === diff.digest) {
      debug('turn-stopping: 这版 diff 已评审', diff.digest.slice(0, 12));
      return undefined;
    }

    // ④ 本回合是否调过且成功
    const call = reviewCallInTurn(ev.events, { toolName: TOOL_NAME, turn: payload?.turn });
    const journal = await withTimeout(readJ(agent.id), 200, { verdict: 'unknown' });

    // 关键：若已有一条更早的评审记录，而当前 diff 与它不同，则「历史上那次调用」
    // 不能算数——必须有一次**晚于该记录**的调用，否则就是「评审完又改」。
    // turn 缺失导致无法证明先后时，保守判为未覆盖（宁可多催一次，不可放过）。
    let callCounts = call.seen;
    if (rec && rec.digest !== diff.digest) {
      const turnNow = typeof payload?.turn === 'number' ? payload.turn : undefined;
      const turnPrev = typeof rec.turn === 'number' ? rec.turn : undefined;
      callCounts = call.seen && turnNow !== undefined && turnPrev !== undefined && turnNow > turnPrev;
    }

    const decision = decideReview({
      eventsAvailable: true,
      callSeen: callCounts,
      resultOk: callCounts ? true : null,
      journalVerdict: journal.verdict,
      digestFresh: undefined,
    });

    // 已评审：记下摘要与回合，之后同一版 diff 不再拦
    if (decision.reviewed) {
      reviewedDigest.set(sid, { digest: diff.digest, turn: payload?.turn });
      lastStatus.set(sid, { reviewed: true, reason: decision.reason, reasons: [], digest: diff.digest });
      debug('turn-stopping: 已评审', decision.reason);
      return undefined;
    }

    // ⑤ 该不该触发
    const cls = classifyTrigger(diff, {
      ignoreGlobs: cfg.ignoreGlobs,
      extraTriggerGlobs: cfg.extraTriggerGlobs,
      thresholds: { removal: cfg.removalThreshold, volume: cfg.volumeThreshold },
    });
    lastStatus.set(sid, {
      reviewed: false,
      reason: decision.reason,
      reasons: cls.reasons,
      undetermined: cls.undetermined,
      files: diff.files?.length ?? 0,
      turnSteers: turnSteers.get(`${sid}::${payload?.turn ?? 'noTurn'}`) ?? 0,
      sessionSteers: sessionSteers.get(sid) ?? 0,
    });
    if (!cls.trigger) {
      debug('turn-stopping: 未命中触发规则，放行');
      return undefined;
    }

    // ⑥ 预算（双闸）
    const turnKey = `${sid}::${typeof payload?.turn === 'number' ? payload.turn : 'noTurn'}`;
    const usedTurn = turnSteers.get(turnKey) ?? 0;
    const usedSession = sessionSteers.get(sid) ?? 0;
    if (usedTurn >= cfg.gateMaxSteersPerTurn || usedSession >= cfg.gateMaxSteersPerSession) {
      debug('turn-stopping: 预算耗尽，如实放行', { usedTurn, usedSession });
      lastStatus.set(sid, {
        ...(lastStatus.get(sid) ?? {}),
        admittedByBudget: true,
      });
      return undefined;
    }

    turnSteers.set(turnKey, usedTurn + 1);
    sessionSteers.set(sid, usedSession + 1);

    const text = renderGateText(cls.reasons, diff);
    agent.steer(createSteerMessage(text));
    lastStatus.set(sid, {
      ...(lastStatus.get(sid) ?? {}),
      steered: true,
      turnSteers: usedTurn + 1,
      sessionSteers: usedSession + 1,
    });
    debug('turn-stopping: 已 steer', cls.reasons);
    return text;
  } catch (error) {
    // 门禁自己坏掉绝不能把回合卡死
    try { debug('turn-stopping 异常，放行', error); } catch { /* ignore */ }
    return undefined;
  }
}

export function statusOf(agentId) {
  const sid = typeof agentId === 'string' && agentId !== '' ? agentId : '*';
  return {
    session: sid,
    last: lastStatus.get(sid) ?? null,
    budgets: {
      turnSteers: Object.fromEntries(turnSteers),
      sessionSteers: Object.fromEntries(sessionSteers),
    },
    reviewedDigests: Object.fromEntries(
      [...reviewedDigest].map(([k, v]) => [k, { digest: String(v?.digest ?? '').slice(0, 12), turn: v?.turn }]),
    ),
  };
}

export function clearGateState() {
  reviewedDigest.clear();
  turnSteers.clear();
  sessionSteers.clear();
  lastStatus.clear();
}
