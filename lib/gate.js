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

import { checklistFor } from './brief.js';
import { getConfig } from './config.js';
import { collectDiff } from './evidence.js';
import { readJournal } from './journal.js';
import { capMap, LIMITS } from './bounded.js';
import { observedPaths, observedSnapshot, resolveSessionId } from './observed.js';
import { eventsOf, reviewCallInTurn } from './replay.js';
import { classifyTrigger, REASONS } from './trigger.js';
import { decideReview, REASON_TEXT } from './verdict.js';

export const STEER_SOURCE_KIND = 'review-gate';
const TOOL_NAME = 'dsh_code_review';
/**
 * 可接受的评审证据工具（任一成功即可）。
 * - dsh_code_review：第三方插件，会 spawn 独立 reviewer 子 Agent，结论更独立；
 * - review_brief：本插件自带，只依赖 tools，因此在拿不到前者的会话（专家子会话）里也能用。
 * 两者不等价（后者由调用者自己审），所以状态里会记下用的是哪个。
 */
const REVIEW_TOOLS = [TOOL_NAME, 'review_brief'];
/** 结构性改动额外要求的证据来源。 */
const LENS_TOOL = 'lens';

/** 每个会话最近一次「通过评审」的 diff 摘要。 */
const reviewedDigest = new Map();
/** 每回合已催次数。 */
const turnSteers = new Map();
/** 每会话已催总额（必须有：payload.turn 缺失时只靠 turn 计数会被反复重置）。 */
const sessionSteers = new Map();
/** 最近一次判定的可观测状态，供 status 工具与变异测试读取。 */
const lastStatus = new Map();

/** 当前是哪个检查点在判定：turn（回合收尾）或 pre-step（回合进行中）。 */
function budgetKeyOf(deps) {
  return typeof deps?.budgetKey === 'string' ? deps.budgetKey : 'turn';
}

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

/** 子 agent 是否也要单独拦（默认要）。 */
function isSubagent(agent) {
  const header = agent?.session?.header;
  const fromHeader = header && typeof header.delegationDepth === 'number' ? header.delegationDepth : undefined;
  const fromSession = agent?.session && typeof agent.session.delegationDepth === 'number'
    ? agent.session.delegationDepth
    : undefined;
  const depth = fromHeader ?? fromSession ?? 0;
  return depth > 0;
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
  const partialNote = diff && diff.partial
    ? '\n（本次取证为降级模式：该目录不是 git 仓库，依据是本会话写过的文件路径，未比对 diff 内容）'
    : '';
  // 结构性改动（新增/删除代码文件）读单文件看不出来，必须从依赖图上看
  const lensNote = reasons.includes(REASONS.STRUCTURAL)
    ? `\n本次动了模块边界（新增/删除代码文件），请再用 ${LENS_TOOL} 看影响面：`
      + `impact / circular / metrics 至少各一次，不要只看单个文件。`
    : '';
  // 有些子会话拿不到 dsh_code_review（实测：agency 专家子会话工具面里没有它）。
  // 门禁探测不到工具是否可用（ctx.tools 只暴露 register），所以给一条诚实的退路，
  // 而不是让它装作已经评审完。
  const noToolNote = `\n如果本会话根本没有 ${TOOL_NAME} 这个工具（部分子会话不加载它），`
    + '请在结论里明确写「本会话无评审工具，未评审」，不要当作已完成。';
  // 只叫它「去评审」是不够的：子 agent 往往调完工具就收工，不做实质审查。
  // 把按改动类型生成的清单直接给出来，并要求逐条给结论 —— 这才是「审到位」。
  const items = checklistFor(reasons).slice(0, 4);
  const checklistNote = '\n审的时候逐条过（每条给「通过 / 有问题：具体是什么」）：\n'
    + items.map((t, i) => `  ${i + 1}) ${t}`).join('\n');
  return (
    `review: 本回合改动命中 ${where}（${n} 个文件），收工前需要一次独立评审。\n`
    + `请调用 ${TOOL_NAME} 评审未提交的更改，例如：${TOOL_NAME}({ input: "审查未提交的更改" })\n`
    + '评审后不要再改代码——改了会重新触发。本条提示每回合最多 1 次。'
    + lensNote
    + checklistNote
    + noToolNote
    + partialNote
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
    // 观察记录用的 key 必须与记录侧一致（session.id 优先），否则降级取证对不上
    const obsSid = resolveSessionId(agent) ?? sid;
    const collect = deps.collectDiff ?? collectDiff;
    const readJ = deps.readJournal ?? readJournal;

    // ① 事件源
    const ev = eventsOf(agent.session);
    if (!ev.available) {
      // fail-open，但必须留下「为什么跳过」——否则「按设计放行」和「插件坏了」
      // 在外部看起来完全一样，这正是最难查的一类故障。
      lastStatus.set(sid, { skipped: 'no-events', detail: ev.source });
      debug('turn-stopping: 事件源不可得，放行', ev.source);
      return undefined;
    }

    // ② 当前改动：优先 git diff；取不到时降级用「本会话观察到的写文件」
    let diff = await withTimeout(collect(cwdOf(agent)), cfg.timeoutMs, { available: false, reason: 'timeout' });
    if (!diff || diff.available !== true) {
      // 降级取证的路径要按 cwd 相对化，否则跨模块规则会被「共同根目录」抵消
      const obsDeps = { cwd: cwdOf(agent) };
      if (typeof deps.readFile === 'function') obsDeps.readFile = deps.readFile;
      const fallback = await observedSnapshot(obsSid, obsDeps);
      if (fallback && fallback.available) {
        debug('turn-stopping: git 不可用，降级为会话观察取证', diff?.reason, fallback.files.length);
        diff = fallback;
      } else {
        lastStatus.set(sid, {
          skipped: 'no-diff',
          detail: diff?.reason ?? 'unknown',
          cwd: cwdOf(agent),
          observedWrites: observedPaths(obsSid).length,
        });
        debug('turn-stopping: diff 不可得且无观察记录，放行', diff?.reason);
        return undefined;
      }
    }

    // ③ 该不该触发——必须在判决之前算出来：结构性改动要求额外证据（lens）
    const cls = classifyTrigger(diff, {
      ignoreGlobs: cfg.ignoreGlobs,
      extraTriggerGlobs: cfg.extraTriggerGlobs,
      thresholds: { removal: cfg.removalThreshold, volume: cfg.volumeThreshold },
    });
    const requiresLens = cls.reasons.includes(REASONS.STRUCTURAL);

    // ④ 这版 diff 是否已经评审过
    const rec = reviewedDigest.get(sid);
    if (rec && rec.digest === diff.digest) {
      debug('turn-stopping: 这版 diff 已评审', diff.digest.slice(0, 12));
      return undefined;
    }

    // ⑤ 本回合是否调过且成功
    let call = { seen: false, callId: undefined, unresolved: false };
    let callTool;
    for (const t of REVIEW_TOOLS) {
      const c = reviewCallInTurn(ev.events, { toolName: t, turn: payload?.turn });
      if (c.seen) { call = c; callTool = t; break; }
      if (c.unresolved) call = c; // 记下「未完成」，继续看下一个工具
    }
    const lensCall = reviewCallInTurn(ev.events, { toolName: LENS_TOOL, turn: payload?.turn });
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
      requiresLens,
      lensSeen: lensCall.seen,
      reviewTool: callTool ?? null,
      callUnresolved: callCounts ? false : call.unresolved === true,
    });

    // 已评审：记下摘要与回合，之后同一版 diff 不再拦
    if (decision.reviewed) {
      reviewedDigest.set(sid, { digest: diff.digest, turn: payload?.turn });
      capMap(reviewedDigest, LIMITS.sessions);
      lastStatus.set(sid, { reviewed: true, reason: decision.reason, reasons: [], digest: diff.digest });
      debug('turn-stopping: 已评审', decision.reason);
      return undefined;
    }

    // ⑥ 该不该触发（cls 已在 ③ 算好）
    lastStatus.set(sid, {
      reviewed: false,
      reason: decision.reason,
      reasons: cls.reasons,
      requiresLens,
      lensSeen: lensCall.seen,
      reviewTool: callTool ?? null,
      undetermined: cls.undetermined,
      files: diff.files?.length ?? 0,
      turnSteers: turnSteers.get(`${sid}::${payload?.turn ?? 'noTurn'}`) ?? 0,
      sessionSteers: sessionSteers.get(sid) ?? 0,
    });
    if (!cls.trigger) {
      debug('turn-stopping: 未命中触发规则，放行');
      return undefined;
    }

    // 评审已发起但结果还没回来 —— 只在 pre-step（回合进行中）容忍。
    //
    // 为什么不能一刀切：turn-stopping 时回合已经结束，「派发了评审但没结果」
    // 意味着这次调用确实没完成，必须拦（这是 F1 blocker 的保护）。
    // 而 pre-step 是回合进行中，agent 很可能正在等评审结果，此时打断它
    // 只会白扣一次额度——这正是 agent 实测反馈的「先扣预算后看评审」。
    const inFlightOk = budgetKeyOf(deps) === 'pre-step';
    if (inFlightOk && call.unresolved === true && !callCounts) {
      lastStatus.set(sid, {
        ...(lastStatus.get(sid) ?? {}),
        awaitingReview: true,
      });
      debug('turn-stopping: 评审已发起，等待中，不介入');
      return undefined;
    }

    const budgetKey = budgetKeyOf(deps);
    const turnKey = `${budgetKey}::${sid}::${typeof payload?.turn === 'number' ? payload.turn : 'noTurn'}`;
    const usedTurn = turnSteers.get(turnKey) ?? 0;
    const sessionKey = `${budgetKey}::${sid}`;
    const usedSession = sessionSteers.get(sessionKey) ?? 0;
    // 0 是合法配置，但它意味着「一次都不许推回」——门禁形同关闭。
    // 这种情况必须在状态里说清楚，否则外部看到的只是「什么都没发生」。
    if (cfg.gateMaxSteersPerTurn <= 0 || cfg.gateMaxSteersPerSession <= 0) {
      lastStatus.set(sid, {
        ...(lastStatus.get(sid) ?? {}),
        admittedByBudget: true,
        budgetDisabled: true,
      });
      debug('turn-stopping: 预算配置为 0，门禁实际关闭，放行');
      return undefined;
    }
    if (usedTurn >= cfg.gateMaxSteersPerTurn || usedSession >= cfg.gateMaxSteersPerSession) {
      debug('turn-stopping: 预算耗尽，如实放行', { usedTurn, usedSession });
      lastStatus.set(sid, {
        ...(lastStatus.get(sid) ?? {}),
        admittedByBudget: true,
      });
      return undefined;
    }

    turnSteers.set(turnKey, usedTurn + 1);
    sessionSteers.set(sessionKey, usedSession + 1);
    // 长跑进程下这些 Map 只增不减 = 慢性泄漏，每次写入后收紧
    capMap(turnSteers, LIMITS.turns);
    capMap(sessionSteers, LIMITS.sessions);

    const text = renderGateText(cls.reasons, diff);
    agent.steer(createSteerMessage(text));
    lastStatus.set(sid, {
      ...(lastStatus.get(sid) ?? {}),
      steered: true,
      turnSteers: usedTurn + 1,
      sessionSteers: usedSession + 1,
    });
    capMap(lastStatus, LIMITS.sessions);
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
