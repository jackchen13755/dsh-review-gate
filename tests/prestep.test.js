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

test('pre-step：写过文件但没评审 → 会介入', async () => {
  clearGateState(); clearObserved(); applyConfig({ gate: true });
  const { ctx, handlers } = makeCtx();
  apply(ctx, { gate: true });
  const pre = handlers.get('agent/pre-step');

  const agent = makeAgent('ps-dirty');
  recordWrite('ps-dirty', '/repo/package.json', { created: false });
  // 让 pre-step 内部走到改写后的判定：cwd 非 git → 降级取证 → config 命中
  await pre({ agent, turn: 1 }, async () => ({ kind: 'enter' }));
  assert.ok(agent.steered.length >= 1, '写过配置类文件却没评审，应当介入');
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
