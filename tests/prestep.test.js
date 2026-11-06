import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';
import { applyConfig } from '../lib/config.js';
import { clearGateState, handleTurnStopping } from '../lib/gate.js';
import { clearObserved, recordWrite } from '../lib/observed.js';

function makeCtx() {
  const handlers = new Map();
  const disposers = [];
  const ctx = {
    on(name, fn) { handlers.set(name, fn); return () => disposers.push(name); },
    effect(fn) { const d = fn(); return () => (typeof d === 'function' ? d() : undefined); },
    tools: { register: () => () => {} },
    logger: { info() {}, warn() {} }, // 静默
  };
  return { ctx, handlers };
}

const cfgDiff = (digest = 'PS1') => ({
  available: true, digest,
  files: [{ path: 'package.json', status: 'M', added: ['x'], removed: [] }],
  totals: { added: 1, removed: 0 },
});

function makeAgent(sid, events = []) {
  const steered = [];
  return {
    id: `agent-${sid}`,
    steered,
    session: { id: sid, header: { cwd: '/not-a-git-repo', delegationDepth: 0 }, snapshotEvents: () => events },
    steer: (m) => steered.push(m),
  };
}

test('apply 必须挂上 agent/pre-step 兜底（治「回合不结束门禁不跑」）', () => {
  applyConfig({ gate: true });
  const { ctx, handlers } = makeCtx();
  apply(ctx, { gate: true });
  assert.ok(handlers.has('agent/pre-step'), '没有 pre-step 兜底，turn/end=0 的会话就完全没有保护');
});

test('pre-step 必须调用 next() 并原样返回它的结果（瀑布钩子不能拦断主流程）', async () => {
  applyConfig({ gate: true });
  const { ctx, handlers } = makeCtx();
  apply(ctx, { gate: true });
  const pre = handlers.get('agent/pre-step');

  const payload = { agent: makeAgent('ps-next'), turn: 1 };
  const sentinel = { kind: 'enter', messages: [] };
  let called = false;
  const out = await pre(payload, async () => { called = true; return sentinel; });
  assert.equal(called, true, '必须调用 next()');
  assert.equal(out, sentinel, '必须原样返回底层结果');
});

test('pre-step：没有写操作时不介入（不打扰纯读会话）', async () => {
  clearGateState(); clearObserved(); applyConfig({ gate: true });
  const { ctx, handlers } = makeCtx();
  apply(ctx, { gate: true });
  const pre = handlers.get('agent/pre-step');

  const agent = makeAgent('ps-clean');
  await pre({ agent, turn: 1 }, async () => ({ kind: 'enter' }));
  assert.equal(agent.steered.length, 0, '没写过文件就不该打扰');
});

test('pre-step：刚写完文件的下一步不介入（给 agent 主动取证的窗口）', async () => {
  clearGateState(); clearObserved(); applyConfig({ gate: true });
  const { ctx, handlers } = makeCtx();
  apply(ctx, { gate: true });
  const pre = handlers.get('agent/pre-step');

  const agent = makeAgent('ps-quiet1');
  recordWrite('ps-quiet1', '/repo/package.json', { created: false });
  await pre({ agent, turn: 1 }, async () => ({ kind: 'enter' }));
  assert.equal(agent.steered.length, 0,
    '刚写完就拦会在 agent 正要调评审的那一刻抢先介入，反而制造它本想避免的返工');
});

test('pre-step：连续多步都没评审 → 才介入', async () => {
  clearGateState(); clearObserved(); applyConfig({ gate: true });
  const { ctx, handlers } = makeCtx();
  apply(ctx, { gate: true });
  const pre = handlers.get('agent/pre-step');

  const agent = makeAgent('ps-quiet2');
  recordWrite('ps-quiet2', '/repo/package.json', { created: false });
  // 第 1 步让路
  await pre({ agent, turn: 1 }, async () => ({ kind: 'enter' }));
  assert.equal(agent.steered.length, 0);
  // 第 2 步应当介入
  await pre({ agent, turn: 1 }, async () => ({ kind: 'enter' }));
  assert.ok(agent.steered.length >= 1, '过了窗口期仍未评审，就该介入');
});

test('pre-step：新一轮写入会重置窗口（每次改动都重新给机会）', async () => {
  clearGateState(); clearObserved(); applyConfig({ gate: true });
  const { ctx, handlers } = makeCtx();
  apply(ctx, { gate: true });
  const pre = handlers.get('agent/pre-step');

  const agent = makeAgent('ps-reset');
  recordWrite('ps-reset', '/repo/a/package.json', { created: false });
  await pre({ agent, turn: 1 }, async () => ({ kind: 'enter' }));
  await pre({ agent, turn: 1 }, async () => ({ kind: 'enter' }));
  const afterFirst = agent.steered.length;
  assert.ok(afterFirst >= 1, '首轮应已介入');

  // 又写了一次 → 窗口重置，下一步不该再拦
  recordWrite('ps-reset', '/repo/b/package.json', { created: false });
  await pre({ agent, turn: 1 }, async () => ({ kind: 'enter' }));
  assert.equal(agent.steered.length, afterFirst, '新写入后应重新给一步窗口');
});

test('pre-step 的预算与 turn-stopping 独立（不互相吃额度）', async () => {
  clearGateState(); clearObserved(); applyConfig({ gate: true, gateMaxSteersPerTurn: 1, gateMaxSteersPerSession: 1 });
  const agent = makeAgent('ps-budget');
  recordWrite('ps-budget', '/repo/package.json', { created: false });

  // 先烧掉 turn-stopping 的额度
  const t1 = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => cfgDiff('A'), readJournal: async () => ({ verdict: 'unknown' }) },
  );
  assert.ok(t1, 'turn-stopping 首次应拦');

  // pre-step 用不同 budgetKey，应有独立额度
  const t2 = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => cfgDiff('B'), readJournal: async () => ({ verdict: 'unknown' }), budgetKey: 'pre-step' },
  );
  assert.ok(t2, 'pre-step 不应被 turn-stopping 的额度连坐');
});

test('pre-step 内部异常不能影响主流程（必须仍然返回 next 的结果）', async () => {
  applyConfig({ gate: true });
  const { ctx, handlers } = makeCtx();
  apply(ctx, { gate: true });
  const pre = handlers.get('agent/pre-step');

  // 构造一个会让内部抛错的 agent（steer 抛）
  const bad = {
    id: 'ps-boom',
    session: { id: 'ps-boom', header: { cwd: '/x', delegationDepth: 0 }, snapshotEvents: () => [] },
    steer() { throw new Error('boom'); },
  };
  recordWrite('ps-boom', '/repo/package.json', { created: false });
  const sentinel = { kind: 'enter' };
  const out = await pre({ agent: bad, turn: 1 }, async () => sentinel);
  assert.equal(out, sentinel, '兜底钩子出错也必须原样返回，不能弄断主流程');
});
