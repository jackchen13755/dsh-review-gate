/**
 * 自动评审：门禁判定「需要评审」时，用宿主 `ctx.commands.execute` 替模型执行 /review。
 *
 * 背景：@michengai/dsh-code-review 1.0.9+ 只有 /review 命令（用户触发），模型自己调不了。
 * 宿主提供的 commands.execute 明确写着「解析并执行已知命令，不经过模型」，所以门禁可以把
 * 这一步自动化：不需要人工敲，也不需要模型自己动手。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { applyConfig } from '../lib/config.js';
import { handleTurnStopping, clearGateState, statusOf } from '../lib/gate.js';

function makeAgent({ id = 's1', events = [], cwd = '/tmp/work' } = {}) {
  const steered = [];
  return {
    id,
    steered,
    session: { header: { cwd, delegationDepth: 0 }, snapshotEvents: () => events },
    steer: (m) => steered.push(m),
  };
}

/** 会触发门禁的 diff。 */
const configDiff = (digest = 'A1') => ({
  available: true,
  digest,
  files: [{ path: 'package.json', status: 'M', added: ['  "x": 1'], removed: [] }],
  totals: { added: 1, removed: 0 },
});

const journalUnknown = async () => ({ verdict: 'unknown' });

function setup(overrides = {}) {
  clearGateState();
  applyConfig({
    gate: true,
    gateMaxSteersPerTurn: 1,
    gateMaxSteersPerSession: 3,
    autoReview: true,
    steer: false,
    autoReviewInput: '审查未提交的更改',
    autoReviewTimeoutMs: 500,
    ...overrides,
  });
}

test('自动评审：需要评审时替模型执行 /review，且不推回、不返回推回文本', async () => {
  setup();
  const agent = makeAgent();
  const lines = [];
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    {
      collectDiff: async () => configDiff(),
      readJournal: journalUnknown,
      runCommand: async (line) => {
        lines.push(line);
        return { kind: 'success' };
      },
    },
  );
  assert.deepEqual(lines, ['/review 审查未提交的更改'], '必须用 /review 命令发起');
  assert.equal(text, undefined, '不应返回推回文本');
  assert.equal(agent.steered.length, 0, '不应 steer');
  const st = statusOf(agent.id).last;
  assert.equal(st.autoReview?.started, true);
  assert.equal(st.needsManualReview, undefined, '成功发起后不该再要求人工');
});

test('自动评审：自定义输入会原样传进 /review', async () => {
  setup({ autoReviewInput: '只看安全面' });
  const lines = [];
  await handleTurnStopping(
    { agent: makeAgent(), turn: 1 },
    { collectDiff: async () => configDiff(), readJournal: journalUnknown, runCommand: async (line) => { lines.push(line); return { kind: 'success' }; } },
  );
  assert.deepEqual(lines, ['/review 只看安全面']);
});

test('命令未解析（插件没装）→ 退回只记录，绝不假装已评审', async () => {
  setup();
  const agent = makeAgent();
  await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => configDiff(), readJournal: journalUnknown, runCommand: async () => undefined },
  );
  const st = statusOf(agent.id).last;
  assert.equal(st.autoReview?.started, false);
  assert.equal(st.autoReview?.failure, 'command-not-resolved');
  assert.equal(st.needsManualReview, true);
  assert.equal(agent.steered.length, 0);
});

test('命令抛错 → 退回只记录并保留失败原因（可排查）', async () => {
  setup();
  const agent = makeAgent();
  await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => configDiff(), readJournal: journalUnknown, runCommand: async () => { throw new Error('boom'); } },
  );
  const st = statusOf(agent.id).last;
  assert.equal(st.autoReview?.started, false);
  assert.match(String(st.autoReview?.failure), /boom/);
  assert.equal(st.needsManualReview, true);
});

test('autoReview=false → 不调用命令（回到人工 /review）', async () => {
  setup({ autoReview: false });
  let called = false;
  await handleTurnStopping(
    { agent: makeAgent(), turn: 1 },
    { collectDiff: async () => configDiff(), readJournal: journalUnknown, runCommand: async () => { called = true; return { kind: 'success' }; } },
  );
  assert.equal(called, false);
});

test('没有 runCommand（宿主无 commands.execute）→ 不崩，退回只记录', async () => {
  setup();
  const agent = makeAgent();
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => configDiff(), readJournal: journalUnknown },
  );
  assert.equal(text, undefined);
  assert.equal(statusOf(agent.id).last.needsManualReview, true);
});

test('已评审（有覆盖当前 diff 的报告消息）→ 不触发自动评审', async () => {
  setup();
  let called = false;
  const events = [{
    type: 'message',
    data: { message: { role: 'user', source: { kind: 'michengai-code-review' }, content: [{ type: 'text', text: 'Here is the completed code review report: ok' }] } },
  }];
  await handleTurnStopping(
    { agent: makeAgent({ events }), turn: 2 },
    { collectDiff: async () => configDiff(), readJournal: journalUnknown, runCommand: async () => { called = true; return { kind: 'success' }; } },
  );
  assert.equal(called, false, '已有覆盖当前 diff 的评审就不该再发起');
});
