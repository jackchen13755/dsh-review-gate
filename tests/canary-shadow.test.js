import test from 'node:test';
import assert from 'node:assert/strict';

import { applyConfig } from '../lib/config.js';
import { handleTurnStopping, clearGateState, statusOf } from '../lib/gate.js';
import { recordReceipt, clearCanaryState } from '../lib/canary.js';

/** 最小 agent：只给 turn-stopping 会碰到的字段。 */
function makeAgent({ id = 's1', depth = 0, events = [], cwd = '/tmp/work' } = {}) {
  const steered = [];
  return {
    id,
    steered,
    session: { header: { cwd, delegationDepth: depth }, snapshotEvents: () => events },
    steer: (m) => steered.push(m),
  };
}

const callEvent = (turn, callId = 'c1') => ({
  type: 'tool/call',
  data: { turn, step: 1, callId, name: 'dsh_code_review', arguments: '{}' },
});
const resultEvent = (turn, callId = 'c1', text = '完成') => ({
  type: 'tool/result',
  data: { turn, step: 2, message: { role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text }] } },
});

/** 会触发门禁的改动：改了根级 package.json。 */
const configDiff = (digest = 'D1') => ({
  available: true,
  digest,
  files: [{ path: 'package.json', status: 'M', added: ['  "x": 1'], removed: [] }],
  totals: { added: 1, removed: 0 },
});

const deps = () => ({ collectDiff: async () => configDiff('D1'), readJournal: async () => ({ verdict: 'unknown' }) });

function reset({ canaryShadow = true } = {}) {
  applyConfig({
    gate: true,
    gateSubagents: true,
    gateMaxSteersPerTurn: 1,
    gateMaxSteersPerSession: 3,
    canaryShadow,
  });
  clearGateState();
  clearCanaryState();
}

test('shadow：没有回执时状态记 missing，门禁照旧推回一次', async () => {
  reset();
  const agent = makeAgent({ id: 'shadow-missing' });
  const text = await handleTurnStopping({ agent, turn: 1 }, deps());
  assert.ok(text, '命中 config 改动，本回合应当被推回');
  assert.equal(agent.steered.length, 1);
  assert.equal(statusOf('shadow-missing').last?.canary, 'missing');
});

test('shadow（关键反向断言）：拿到 verified 回执后，放行行为必须与没回执时完全一致', async () => {
  // 先跑一次「没有回执」的基线
  reset();
  const a1 = makeAgent({ id: 'shadow-base' });
  await handleTurnStopping({ agent: a1, turn: 1 }, deps());
  const baseline = statusOf('shadow-base').last;

  // 再跑一次「有 verified 回执」的同一场景
  reset();
  const a2 = makeAgent({ id: 'shadow-verified' });
  recordReceipt('shadow-verified', { killed: true });
  await handleTurnStopping({ agent: a2, turn: 1 }, deps());
  const withReceipt = statusOf('shadow-verified').last;

  assert.equal(withReceipt.canary, 'verified');
  // 回执绝不能改变放行结论：该推回还是推回
  assert.equal(a2.steered.length, 1, 'shadow 阶段 canary 不参与放行，必须照旧推回');
  assert.deepEqual(withReceipt.reasons, baseline.reasons, 'canary 不许污染 reasons');
  assert.equal(withReceipt.reviewed, baseline.reviewed, 'canary 不许改变 reviewed 结论');
  assert.equal(withReceipt.reason, baseline.reason);
});

test('shadow：关掉开关后状态为 off，且不读取任何回执', async () => {
  reset({ canaryShadow: false });
  const agent = makeAgent({ id: 'shadow-off' });
  recordReceipt('shadow-off', { killed: true });
  await handleTurnStopping({ agent, turn: 1 }, deps());
  assert.equal(statusOf('shadow-off').last?.canary, 'off');
});

test('shadow：已评审的回合也记录 canary 状态，且 reviewed 不受影响', async () => {
  reset();
  recordReceipt('shadow-reviewed', { killed: true });
  const agent = makeAgent({
    id: 'shadow-reviewed',
    events: [callEvent(1, 'c1'), resultEvent(1, 'c1', '审查完成：未发现阻塞问题')],
  });
  const text = await handleTurnStopping({ agent, turn: 1 }, deps());
  assert.equal(text, undefined, '已评审的回合不该被推回');
  const st = statusOf('shadow-reviewed').last;
  assert.equal(st.reviewed, true);
  assert.equal(st.canary, 'verified');
});

test('shadow：unproven（有回执但没杀死）不会被误记成 verified', async () => {
  reset();
  recordReceipt('shadow-unproven', { killed: false });
  const agent = makeAgent({ id: 'shadow-unproven' });
  await handleTurnStopping({ agent, turn: 1 }, deps());
  assert.equal(statusOf('shadow-unproven').last?.canary, 'unproven');
});
