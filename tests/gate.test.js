import test from 'node:test';
import assert from 'node:assert/strict';

import { applyConfig } from '../lib/config.js';
import { handleTurnStopping, clearGateState, createSteerMessage, STEER_SOURCE_KIND } from '../lib/gate.js';

/** 造一个最小 agent：只有 turn-stopping 会用到的字段。 */
function makeAgent({ id = 's1', depth = 0, events = [], cwd = '/tmp/work' } = {}) {
  const steered = [];
  const agent = {
    id,
    steered,
    session: {
      header: { cwd, delegationDepth: depth },
      snapshotEvents: () => events,
    },
    steer: (m) => steered.push(m),
  };
  return agent;
}

const callEvent = (turn, callId = 'c1') => ({
  type: 'tool/call',
  data: { turn, step: 1, callId, name: 'dsh_code_review', arguments: '{}' },
});
const resultEvent = (turn, callId = 'c1', text = '完成') => ({
  type: 'tool/result',
  data: { turn, step: 2, message: { role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text }] } },
});

/** 一个会触发门禁的 diff：改了根级 package.json。 */
const configDiff = (digest = 'D1') => ({
  available: true,
  digest,
  files: [{ path: 'package.json', status: 'M', added: ['  "x": 1'], removed: [] }],
  totals: { added: 1, removed: 0 },
});

/** 一个不该触发门禁的 diff：只改注释。 */
const commentDiff = (digest = 'C1') => ({
  available: true,
  digest,
  files: [{ path: 'src/a.ts', status: 'M', added: ['// 注释'], removed: [] }],
  totals: { added: 1, removed: 0 },
});

function setup(overrides = {}) {
  clearGateState();
  applyConfig({ gate: true, gateMaxSteersPerTurn: 1, gateMaxSteersPerSession: 3, ...overrides });
}

const journalUnknown = async () => ({ verdict: 'unknown' });

// ------------------------------------------------------------ 核心：真能拦住

test('M1（红）：改动命中配置类文件但没评审 → 必须 steer', async () => {
  setup();
  const agent = makeAgent({ events: [] });
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => configDiff('D1'), readJournal: journalUnknown },
  );

  assert.ok(text, '必须返回 steer 文本');
  assert.equal(agent.steered.length, 1, '必须真的调用了 agent.steer');
  assert.match(text, /dsh_code_review/, 'steer 文本要指名修复动作');
  assert.match(text, /config/, '要说明命中的原因');
});

test('steer 消息的 source.kind 必须是裸生产方名，不能是 plugin', () => {
  const msg = createSteerMessage('x');
  assert.equal(STEER_SOURCE_KIND, 'review-gate');
  assert.equal(msg.source.kind, 'review-gate');
  assert.notEqual(msg.source.kind, 'plugin', "v4 会拒收 kind:'plugin'，且拒收发生在 steer() 返回之后，吞不掉");
  assert.equal(msg.role, 'user');
  assert.ok(msg.id, '必须有 id');
});

test('M2：同回合第二次收尾不再 steer（每回合预算）', async () => {
  setup();
  const agent = makeAgent({ events: [] });
  const deps = { collectDiff: async () => configDiff('D1'), readJournal: journalUnknown };

  const first = await handleTurnStopping({ agent, turn: 1 }, deps);
  const second = await handleTurnStopping({ agent, turn: 1 }, deps);

  assert.ok(first, '第一次应 steer');
  assert.equal(second, undefined, '第二次必须放行（预算耗尽）');
  assert.equal(agent.steered.length, 1);
});

test('M3（绿）：真的调用过且成功 → 不 steer', async () => {
  setup();
  const agent = makeAgent({ events: [callEvent(1), resultEvent(1)] });
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => configDiff('D1'), readJournal: journalUnknown },
  );
  assert.equal(text, undefined);
  assert.equal(agent.steered.length, 0);
});

test('M4（最关键）：评审后又改代码 → 必须再次拦住', async () => {
  setup();
  // 第 1 回合：已评审通过，记下 D1
  const agent1 = makeAgent({ events: [callEvent(1), resultEvent(1)] });
  await handleTurnStopping({ agent: agent1, turn: 1 }, { collectDiff: async () => configDiff('D1'), readJournal: journalUnknown });
  assert.equal(agent1.steered.length, 0);

  // 第 2 回合：同一会话（同 id），diff 变成 D2，且本回合没有新的评审调用
  const agent2 = makeAgent({ events: [callEvent(1), resultEvent(1)] });
  const text = await handleTurnStopping(
    { agent: agent2, turn: 2 },
    { collectDiff: async () => configDiff('D2'), readJournal: journalUnknown },
  );
  assert.ok(text, '改过之后旧评审不能覆盖新 diff，必须再拦');
  assert.equal(agent2.steered.length, 1);
});

test('M5：伪造 journal（accept）但没有真实调用 → 仍必须拦住', async () => {
  setup();
  const agent = makeAgent({ events: [] }); // 没有任何 tool/call
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => configDiff('D1'), readJournal: async () => ({ verdict: 'accept' }) },
  );
  assert.ok(text, 'journal 只能是交叉校验；没有真实调用就不能算已评审');
  assert.equal(agent.steered.length, 1);
});

test('journal 为 reject 时即便有调用也拦（finished-but-failed 回归）', async () => {
  setup();
  const agent = makeAgent({ events: [callEvent(1), resultEvent(1)] });
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => configDiff('D1'), readJournal: async () => ({ verdict: 'reject' }) },
  );
  assert.ok(text);
});

// ------------------------------------------------------------ fail-open 边界

test('M6：diff 不可得 → 放行（不能因为非 git 仓就永远收不了工）', async () => {
  setup();
  const agent = makeAgent({ events: [] });
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => ({ available: false, files: [], totals: { added: 0, removed: 0 }, digest: '', reason: 'not a git work tree' }), readJournal: journalUnknown },
  );
  assert.equal(text, undefined);
  assert.equal(agent.steered.length, 0);
});

test('事件源不可得 → 放行', async () => {
  setup();
  const agent = { id: 's9', steered: [], session: { header: { cwd: '/tmp/w' } }, steer(m) { this.steered.push(m); } };
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => configDiff('D1'), readJournal: journalUnknown },
  );
  assert.equal(text, undefined);
  assert.equal(agent.steered.length, 0);
});

test('未命中触发规则（纯注释改动）→ 放行，不打扰', async () => {
  setup();
  const agent = makeAgent({ events: [] });
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => commentDiff('C1'), readJournal: journalUnknown },
  );
  assert.equal(text, undefined);
});

test('门禁总开关关掉 → 完全不介入', async () => {
  setup({ gate: false });
  const agent = makeAgent({ events: [] });
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => configDiff('D1'), readJournal: journalUnknown },
  );
  assert.equal(text, undefined);
});

test('子 agent 默认不拦（改动会进同一个 diff）', async () => {
  setup();
  const agent = makeAgent({ depth: 1, events: [] });
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => configDiff('D1'), readJournal: journalUnknown },
  );
  assert.equal(text, undefined);
});

test('打开 gateSubagents 后子 agent 也会被拦', async () => {
  setup({ gateSubagents: true });
  const agent = makeAgent({ depth: 1, events: [] });
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => configDiff('D1'), readJournal: journalUnknown },
  );
  assert.ok(text);
});

// ------------------------------------------------------------ 健壮性

test('会话总额兜底：turn 缺失时也不会无限催（每会话上限 3）', async () => {
  setup({ gateMaxSteersPerTurn: 99, gateMaxSteersPerSession: 3 });
  let steers = 0;
  for (let i = 0; i < 10; i += 1) {
    const agent = makeAgent({ events: [] });
    // 刻意不传 turn：只靠 session 级预算
    const text = await handleTurnStopping(
      { agent },
      { collectDiff: async () => configDiff(`D${i}`), readJournal: journalUnknown },
    );
    if (text) steers += 1;
  }
  assert.equal(steers, 3, '必须有会话级总额，否则 payload.turn 缺失时会被无限推回');
});

test('取证抛错不会把回合卡死（门禁自身故障必须放行）', async () => {
  setup();
  const agent = makeAgent({ events: [] });
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => { throw new Error('boom'); }, readJournal: journalUnknown },
  );
  assert.equal(text, undefined);
});

test('没有 agent / agent 没有 steer：安全返回', async () => {
  setup();
  assert.equal(await handleTurnStopping({}, {}), undefined);
  assert.equal(await handleTurnStopping({ agent: { id: 'x' } }, {}), undefined);
});
