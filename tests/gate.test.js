import test from 'node:test';
import assert from 'node:assert/strict';

import { applyConfig } from '../lib/config.js';
import { handleTurnStopping, clearGateState, createSteerMessage, STEER_SOURCE_KIND, statusOf } from '../lib/gate.js';

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
  // 默认 steer=true：既有用例断言的是推回行为（离散型开关，不是契约默认值）。
  // 运行配置里 steer=false（发布配置显式关闭），另有一条用例专门钉「默认不推回」。
  overrides = { steer: true, ...overrides };
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

test('默认不推回：命中触发规则也只记状态（评审工具已恢复，由 agent 自己发起）', async () => {
  setup({ steer: false });
  const agent = makeAgent({ events: [] });
  // 不代跑 /review 之后，「不推回」的载体从 runCommand 换成了状态字段：
  // 门禁只写 needsAgentReview + reviewRoot，发起方是 agent 自己。
  const lines = [];
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    {
      collectDiff: async () => configDiff('NS1'),
      readJournal: journalUnknown,
      runCommand: async (line) => { lines.push(line); return { kind: 'success' }; },
    },
  );
  assert.equal(text, undefined, '不该返回推回文本');
  assert.equal(agent.steered.length, 0, '不该调用 agent.steer');
  const st = statusOf(agent.id).last;
  assert.equal(st.needsAgentReview, true, '状态里必须标出「该由 agent 自己评审」');
  assert.match(String(st.hint), /dsh_code_review/, '提示要指向模型可调用的工具');
  assert.equal(st.reviewRoot, '/tmp/work', '必须记录「评审该指向哪棵树」= 会话目录');
  assert.deepEqual(lines, [], '门禁不得再代跑 /review');
});

test('子 agent 一律不拦：评审工具被禁在子 Agent 之外，它没有可用载体', async () => {
  // 2026-11-10 契约变更：dsh_code_review 只允许主会话调用（lib/review-tool-policy.js），
  // 子 Agent 里没有任何被接受的评审载体——再拦就是把它推进一个永远满足不了的要求。
  setup();
  const agent = makeAgent({ depth: 1, events: [] });
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => configDiff('D1'), readJournal: journalUnknown },
  );
  assert.equal(text, undefined, '子 agent 不应被推回去要求一个拿不到的工具');
  assert.equal(agent.steered.length, 0);
});

test('旧开关 gateSubagents 已删除：传 true 也不再拦子 agent（不留半生效的配置）', async () => {
  setup({ gateSubagents: true });
  const agent = makeAgent({ depth: 1, events: [] });
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => configDiff('D1'), readJournal: journalUnknown },
  );
  assert.equal(text, undefined, '配置项已删，传了也不能改变契约');
  assert.equal(agent.steered.length, 0);
});

test('子 agent 不拦（契约）', async () => {
  setup({ gateSubagents: false });
  const agent = makeAgent({ depth: 1, events: [] });
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => configDiff('D1'), readJournal: journalUnknown },
  );
  assert.equal(text, undefined);
});

test('delegationDepth 只挂在 session 上时也要认出来（否则会当成主会话误拦）', async () => {
  // 判别性设计：把 gateSubagents 关掉后，
  //   · 认得出是子 agent → 不拦
  //   · 认不出（当成主会话）→ 会拦
  // 这样才真的测到 isSubagent，而不是「两边都过」的空断言。
  setup({ gateSubagents: false });
  const steered = [];
  const agent = {
    id: 'sub-agent-2',
    session: {
      header: { cwd: '/tmp/work' }, // 关键：header 里没有 delegationDepth
      delegationDepth: 2,
      snapshotEvents: () => [],
    },
    steer: (m) => steered.push(m),
  };
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => configDiff('D1'), readJournal: journalUnknown },
  );
  assert.equal(text, undefined, '若把子 agent 误判成主会话，这里会被拦——说明深度探测失效');
  assert.equal(steered.length, 0);
});

test('深度探测的对照：同样关掉 gateSubagents，主会话必须仍被拦', async () => {
  setup({ gateSubagents: false });
  const agent = makeAgent({ id: 'plain-main', sid: 'plain-main-sess', depth: 0, events: [] });
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => configDiff('D1'), readJournal: journalUnknown },
  );
  assert.ok(text, '主会话不受 gateSubagents 影响');
});

// 子 agent 不再参与门禁（契约），所以「子 agent 预算独立计量」这个用例失去主体；
// 预算仍按会话 id 分桶（见下面的会话总额兜底用例），只是不再有子 agent 这一路。

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

// --------------------------------------- 假绿回归：接线层（2026-11-06，阶段 A）

test('假绿①接线：评审调用失败 → reason 必须是 call-failed，不许报成 no-call', async () => {
  setup();
  // 事件里有真实的 tool/call + 一条失败结果（第三方插件用 REVIEW_FAILED 报错）
  const agent = makeAgent({ events: [callEvent(1), resultEvent(1, 'c1', 'REVIEW_FAILED: 子模型挂了')] });
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => configDiff('D1'), readJournal: journalUnknown },
  );

  assert.ok(text, '失败的评审必须仍然拦住（这点没变）');
  const st = statusOf(agent.id).last;
  assert.equal(
    st.reason,
    'call-failed',
    `失败要说成失败。实际 reason=${st.reason}（若为 no-call，说明 gate 又把 resultOk 固定写成了 true）`,
  );
});

test('假绿②接线：审完又改 → reason 必须是 stale，不许报成 no-call', async () => {
  setup();
  const agent = makeAgent({ events: [callEvent(1), resultEvent(1, 'c1', '完成')] });

  // 第一回合：真实评审并通过，记下 digest D1
  const first = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => configDiff('D1'), readJournal: journalUnknown },
  );
  assert.equal(first, undefined, '第一回合已评审，不该拦');

  // 第二回合：代码又改了（digest D2），且本回合没有任何评审调用
  agent.session.snapshotEvents = () => [];
  const second = await handleTurnStopping(
    { agent, turn: 2 },
    { collectDiff: async () => configDiff('D2'), readJournal: journalUnknown },
  );

  assert.ok(second, '审完又改必须拦住（这点没变）');
  const st = statusOf(agent.id).last;
  assert.equal(
    st.reason,
    'stale',
    `应报「评审未覆盖当前这版 diff」。实际 reason=${st.reason}（若为 no-call，说明 digestFresh 又被固定传成了 undefined）`,
  );
});

// ------------------------- 死路回归：turn 缺失时重审必须能放行（2026-11-06，阶段 A）

test('死路回归：payload.turn 缺失时，改成 D2 后完整重审一次必须放行', async () => {
  setup();
  let events = [callEvent(1, 'c1'), resultEvent(1, 'c1', '完成')];
  const agent = makeAgent({ events: [] });
  agent.session.snapshotEvents = () => events;

  // 首轮：真实评审并通过，记下 D1（本回合没有 turn）
  const first = await handleTurnStopping(
    { agent },
    { collectDiff: async () => configDiff('D1'), readJournal: journalUnknown },
  );
  assert.equal(first, undefined, '首轮已评审，应放行');

  // 代码改成 D2，并且完整重审了一次（新的 callId）
  events = [callEvent(1, 'c1'), resultEvent(1, 'c1', '完成'), callEvent(2, 'c2'), resultEvent(2, 'c2', '完成')];
  const second = await handleTurnStopping(
    { agent },
    { collectDiff: async () => configDiff('D2'), readJournal: journalUnknown },
  );

  assert.equal(
    second,
    undefined,
    '认真重审过就必须放行。被拦说明 turn 缺失时退化成永久 stale——重审多少次都放不出去',
  );
  assert.equal(statusOf(agent.id).last.reason, 'ok');
});

test('死路回归的反向断言：turn 缺失、改了代码但没重审 → 仍必须拦（放宽不能放过）', async () => {
  setup();
  const events = [callEvent(1, 'c1'), resultEvent(1, 'c1', '完成')];
  const agent = makeAgent({ events: [] });
  agent.session.snapshotEvents = () => events;

  await handleTurnStopping(
    { agent },
    { collectDiff: async () => configDiff('D1'), readJournal: journalUnknown },
  );

  // 代码又改了，但没有任何新的评审调用
  const second = await handleTurnStopping(
    { agent },
    { collectDiff: async () => configDiff('D2'), readJournal: journalUnknown },
  );

  assert.ok(second, '没重审就必须拦');
  assert.equal(statusOf(agent.id).last.reason, 'stale', '原因仍要说清是「评审没覆盖这版 diff」');
});
