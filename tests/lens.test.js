import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyTrigger, REASONS } from '../lib/trigger.js';
import { decideReview } from '../lib/verdict.js';
import { applyConfig } from '../lib/config.js';
import { handleTurnStopping, clearGateState } from '../lib/gate.js';

// ------------------------------------------------------------ trigger 层

const f = (path, status = 'M', added = [], removed = []) => ({ path, status, added, removed });

test('新增代码文件 → 命中 structural（等于动了模块边界）', () => {
  const r = classifyTrigger({ available: true, files: [f('lib/newmod.js', 'A', ['export const a = 1'])] });
  assert.equal(r.trigger, true);
  assert.ok(r.reasons.includes(REASONS.STRUCTURAL), '新增 .js 必须算结构性改动');
});

test('删除代码文件 → 同时命中 structural 与 deletion', () => {
  const r = classifyTrigger({ available: true, files: [f('lib/old.ts', 'D', [], ['export const b = 2'])] });
  assert.ok(r.reasons.includes(REASONS.STRUCTURAL));
  assert.ok(r.reasons.includes(REASONS.DELETION));
});

test('新增非代码文件（.md）→ 不算结构性改动', () => {
  const r = classifyTrigger({ available: true, files: [f('docs/note.md', 'A', ['# 标题'])] });
  assert.equal(r.reasons.includes(REASONS.STRUCTURAL), false, '文档新增不该要求 lens');
});

test('修改（非增删）代码文件 → 不算结构性改动', () => {
  const r = classifyTrigger({ available: true, files: [f('lib/a.js', 'M', ['const x = 1'])] });
  assert.equal(r.reasons.includes(REASONS.STRUCTURAL), false, '改一行代码不等于动模块边界');
});

// ------------------------------------------------------------ verdict 层

test('结构性改动：有评审但没 lens → no-lens', () => {
  const r = decideReview({
    callSeen: true, resultOk: true, journalVerdict: 'unknown',
    requiresLens: true, lensSeen: false,
  });
  assert.equal(r.reviewed, false);
  assert.equal(r.reason, 'no-lens');
});

test('结构性改动：评审 + lens 都跑过 → 通过', () => {
  const r = decideReview({
    callSeen: true, resultOk: true, journalVerdict: 'unknown',
    requiresLens: true, lensSeen: true,
  });
  assert.equal(r.reviewed, true);
});

test('非结构性改动：不该因为缺 lens 被拦（避免变成噪音）', () => {
  const r = decideReview({
    callSeen: true, resultOk: true, journalVerdict: 'unknown',
    requiresLens: false, lensSeen: false,
  });
  assert.equal(r.reviewed, true, '普通改动只要求评审，不额外要求 lens');
});

test('没评审时，即使 lens 跑过也仍然不通过（lens 不能替代评审）', () => {
  const r = decideReview({
    callSeen: false, requiresLens: true, lensSeen: true,
  });
  assert.equal(r.reviewed, false);
  assert.equal(r.reason, 'no-call');
});

// ------------------------------------------------------------ gate 层（集成）

const callEvent = (turn, name, callId) => ({
  type: 'tool/call',
  data: { turn, step: 1, callId, name, arguments: '{}' },
});
const resultEvent = (turn, callId) => ({
  type: 'tool/result',
  data: { turn, step: 2, message: { role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text: 'ok' }] } },
});

/** 结构性改动：新增了一个代码文件。 */
const structuralDiff = (digest = 'S1') => ({
  available: true,
  digest,
  files: [{ path: 'lib/newmod.js', status: 'A', added: ['export function handle() {}'], removed: [] }],
  totals: { added: 1, removed: 0 },
});

function makeAgent({ sid = 'lens-sess', events = [] } = {}) {
  const steered = [];
  return {
    id: `agent-${sid}`,
    steered,
    session: { id: sid, header: { cwd: '/tmp/work', delegationDepth: 0 }, snapshotEvents: () => events },
    steer: (m) => steered.push(m),
  };
}

const journalUnknown = async () => ({ verdict: 'unknown' });

test('新增代码文件 + 只评审不跑 lens → 必须拦住，且文本点名要求 lens', async () => {
  clearGateState();
  applyConfig({ gate: true });
  const agent = makeAgent({ events: [callEvent(1, 'dsh_code_review', 'c1'), resultEvent(1, 'c1')] });

  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => structuralDiff('S1'), readJournal: journalUnknown },
  );

  assert.ok(text, '结构性改动缺 lens 必须被拦');
  assert.match(text, /structural/);
  assert.match(text, /lens/, 'steer 文本必须明确要求 lens');
  assert.equal(agent.steered.length, 1);
});

test('新增代码文件 + 评审 + lens 都跑过 → 放行', async () => {
  clearGateState();
  applyConfig({ gate: true });
  const agent = makeAgent({
    events: [
      callEvent(1, 'dsh_code_review', 'c1'), resultEvent(1, 'c1'),
      callEvent(1, 'lens', 'c2'), resultEvent(1, 'c2'),
    ],
  });

  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => structuralDiff('S1'), readJournal: journalUnknown },
  );
  assert.equal(text, undefined, '两样证据都齐了就不该再拦');
  assert.equal(agent.steered.length, 0);
});

test('普通代码修改 + 只评审不跑 lens → 放行（不额外要求 lens）', async () => {
  clearGateState();
  applyConfig({ gate: true });
  const agent = makeAgent({ events: [callEvent(1, 'dsh_code_review', 'c1'), resultEvent(1, 'c1')] });

  const plainDiff = {
    available: true,
    digest: 'P1',
    files: [{ path: 'lib/a.js', status: 'M', added: ['const x = 1'], removed: [] }],
    totals: { added: 1, removed: 0 },
  };
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => plainDiff, readJournal: journalUnknown },
  );
  assert.equal(text, undefined);
});

test('lens 调用失败不算数（和评审一样要求成功）', async () => {
  clearGateState();
  applyConfig({ gate: true });
  const agent = makeAgent({
    events: [
      callEvent(1, 'dsh_code_review', 'c1'), resultEvent(1, 'c1'),
      callEvent(1, 'lens', 'c2'),
      { type: 'tool/result', data: { turn: 1, step: 2, message: { role: 'tool', source: { kind: 'tool', callId: 'c2' }, isError: true, content: [] } } },
    ],
  });

  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => structuralDiff('S1'), readJournal: journalUnknown },
  );
  assert.ok(text, 'lens 失败不能当证据');
});
