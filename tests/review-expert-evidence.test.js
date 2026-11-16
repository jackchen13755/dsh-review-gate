import test from 'node:test';
import assert from 'node:assert/strict';

import { applyConfig } from '../lib/config.js';
import { handleTurnStopping, clearGateState, statusOf } from '../lib/gate.js';

/**
 * 门禁判定矩阵（2026-11-16 契约）。
 *
 * 评审证据只有一条：**主会话**调用 `summon_expert` / `summon_experts` 点名
 * 「代码审查工程师」，且那次调用有成功结果。文件里每条要求都配一条反向断言：
 * 只验「代码审查工程师被算进来」会把判据放宽成「任何召唤都算」也全绿。
 *
 * 旧实现（gate.js:34 `TOOL_NAME='dsh_code_review'` / gate.js:42 `REVIEW_TOOLS=[TOOL_NAME]`）
 * 下，本文件里所有「专家评审 → 放行」用例都会红：门禁只认那个已卸载的工具，
 * 于是 status.reason 恒为 `no-call` 并把回合推回。
 */

function makeAgent({ id = 's1', depth = 0, events = [], cwd = '/tmp/work', noSession = false } = {}) {
  const steered = [];
  const agent = {
    id,
    steered,
    session: noSession ? undefined : { header: { cwd, delegationDepth: depth }, snapshotEvents: () => events },
    steer: (message) => steered.push(message),
  };
  return agent;
}

const expertArgs = (expert) => JSON.stringify({ expert, task: '审查未提交的更改' });
const batchArgs = (experts) => JSON.stringify({ experts: experts.map((expert) => ({ expert, task: '审查' })) });

const callEvent = (turn, callId = 'c1', name = 'summon_expert', args = expertArgs('代码审查工程师')) => ({
  type: 'tool/call',
  data: { turn, step: 1, callId, name, arguments: args },
});
const resultEvent = (turn, callId = 'c1', text = '审查完成：3 处发现', isError = false) => ({
  type: 'tool/result',
  data: {
    turn,
    step: 2,
    message: { role: 'tool', source: { kind: 'tool', callId }, isError, content: [{ type: 'text', text }] },
  },
});
/** 另一条调用的结果：用来表示「宿主是会记结果的」，但评审那条没有结果。 */
const otherResult = (turn) => resultEvent(turn, 'other-call', 'x');

/** 命中 config 规则的 diff。 */
const configDiff = (digest = 'D1') => ({
  available: true,
  digest,
  files: [{ path: 'package.json', status: 'M', added: ['  "x": 1'], removed: [] }],
  totals: { added: 1, removed: 0 },
});

const journalUnknown = async () => ({ verdict: 'unknown' });

function setup() {
  clearGateState();
  applyConfig({ gate: true, gateMaxSteersPerTurn: 1, gateMaxSteersPerSession: 3, steer: true });
}

const run = (agent, turn = 1, diff = configDiff('D1')) => handleTurnStopping(
  { agent, turn },
  { collectDiff: async () => diff, readJournal: journalUnknown, liveCwd: () => agent.session?.header?.cwd ?? '/tmp/work' },
);

// ---------------------------------------------------------------- 1. 空/不可得

test('1a. 空 events / 无 tool call → 不算已评审（reason=no-call）', async () => {
  setup();
  for (const events of [[], [{ type: 'tool/call', data: { turn: 1, callId: 'x', name: 'bash' } }]]) {
    const agent = makeAgent({ id: `empty-${events.length}`, events });
    const text = await run(agent);
    assert.ok(text, '没有评审证据必须拦住');
    assert.equal(statusOf(agent.id).last.reason, 'no-call');
    assert.equal(statusOf(agent.id).last.reviewed, false);

    // 正向对照：同一份 diff、同一套 deps，只把证据换成专家评审 → 必须放行
    const ok = makeAgent({ id: `empty-ok-${events.length}`, events: [callEvent(1), resultEvent(1)] });
    assert.equal(await run(ok), undefined, '对照组必须放行，否则这条用例证明不了判据在起作用');
    assert.equal(statusOf(ok.id).last.reviewed, true);
  }
});

test('1b. 事件源不可得（session 缺失）→ 放行，但状态要能说明为什么', async () => {
  setup();
  const agent = makeAgent({ id: 'no-events', noSession: true });
  assert.equal(await run(agent), undefined);
  assert.equal(statusOf('no-events').last.skipped, 'no-events', '「按设计放行」必须能与「门禁坏了」区分开');
});

test('1c. 事件源为 undefined（eventsOf 拿不到）也不抛、不放行成 reviewed', async () => {
  setup();
  const agent = makeAgent({ id: 'undef-events' });
  agent.session.snapshotEvents = () => undefined;
  await run(agent);
  assert.notEqual(statusOf('undef-events').last?.reviewed, true);
});

// ---------------------------------------------------------------- 2. 普通专家

test('2. 召唤「UI 设计师」成功 → 不算已评审（反例必须真的被拦）', async () => {
  setup();
  const agent = makeAgent({
    id: 'designer',
    events: [callEvent(1, 'c1', 'summon_expert', expertArgs('UI 设计师')), resultEvent(1, 'c1')],
  });
  const text = await run(agent);
  assert.ok(text, '叫了别的专家不等于评审');
  assert.equal(statusOf('designer').last.reason, 'no-call');
  assert.equal(statusOf('designer').last.reviewed, false);
});

test('2b. 同一批事件里只有「架构师 + UI 设计师」→ 仍然不算', async () => {
  setup();
  const agent = makeAgent({
    id: 'batch-designers',
    events: [
      callEvent(1, 'c1', 'summon_experts', batchArgs(['软件架构师', 'UI 设计师'])),
      resultEvent(1, 'c1'),
    ],
  });
  assert.ok(await run(agent));
  assert.equal(statusOf('batch-designers').last.reason, 'no-call');
});

// ---------------------------------------------------------------- 3. 中文名 / slug

test('3. 「代码审查工程师」中文名 → 算已评审', async () => {
  setup();
  const agent = makeAgent({ id: 'cn', events: [callEvent(1), resultEvent(1)] });
  assert.equal(await run(agent), undefined);
  assert.equal(statusOf('cn').last.reason, 'ok');
  assert.equal(statusOf('cn').last.reviewed, true);
});

test('3b. 三种 slug 写法都算（engineering-code-reviewer / code-reviewer / engineering/code-reviewer）', async () => {
  setup();
  for (const [index, slug] of ['engineering-code-reviewer', 'code-reviewer', 'engineering/code-reviewer'].entries()) {
    const agent = makeAgent({
      id: `slug-${index}`,
      events: [callEvent(1, 'c1', 'summon_expert', expertArgs(slug)), resultEvent(1, 'c1')],
    });
    assert.equal(await run(agent), undefined, `${slug} 应算已评审`);
    assert.equal(statusOf(`slug-${index}`).last.reviewed, true);
  }
});

test('3c. 名字像但不是它（「代码审查工程师助理」）→ 不算', async () => {
  setup();
  const agent = makeAgent({
    id: 'almost',
    events: [callEvent(1, 'c1', 'summon_expert', expertArgs('代码审查工程师助理')), resultEvent(1, 'c1')],
  });
  assert.ok(await run(agent), '名字里带那几个字不等于就是审查工程师');
  assert.equal(statusOf('almost').last.reason, 'no-call');
});

// ---------------------------------------------------------------- 4. 批量

test('4. summon_experts 批量里含审查工程师 → 算已评审（并记下命中的工具名）', async () => {
  setup();
  const agent = makeAgent({
    id: 'batch-reviewer',
    events: [
      callEvent(1, 'c1', 'summon_experts', batchArgs(['UI 设计师', 'engineering-code-reviewer'])),
      resultEvent(1, 'c1'),
    ],
  });
  assert.equal(await run(agent), undefined, '批量里评审确实跑了，就该算');
  const last = statusOf('batch-reviewer').last;
  assert.equal(last.reviewed, true);
  assert.equal(last.reason, 'ok');
  assert.equal(last.reviewTool, 'summon_experts', '状态里要能看出命中的是哪一次工具调用');
});

// ---------------------------------------------------------------- 5. 失败 / 无结果

test('5a. 调用了但结果明确失败 → 不算，reason=call-failed（不是 no-call）', async () => {
  setup();
  const agent = makeAgent({ id: 'failed', events: [callEvent(1), resultEvent(1, 'c1', '审查挂了', true)] });
  assert.ok(await run(agent));
  assert.equal(
    statusOf('failed').last.reason,
    'call-failed',
    '「调了但失败」必须与「没调」区分开，否则排查方向完全错',
  );
});

test('5b. 宿主要记结果、但这条调用没有结果 → 不算，reason=call-unresolved', async () => {
  setup();
  const agent = makeAgent({ id: 'unresolved', events: [callEvent(1), otherResult(1)] });
  assert.ok(await run(agent));
  assert.equal(statusOf('unresolved').last.reason, 'call-unresolved');
});

test('5c. 宿主根本不记结果 → 按调用事实算（不能把这类宿主永远卡死）', async () => {
  setup();
  const agent = makeAgent({ id: 'no-results-host', events: [callEvent(1)] });
  assert.equal(await run(agent), undefined, '没有任何 tool/result 的宿主不是「评审失败」');
  assert.equal(statusOf('no-results-host').last.reviewed, true);
});

// ---------------------------------------------------------------- 6. 新鲜度

test('6. 评审之后又改代码 → 不算（reason=stale），改完重审一次才能放行', async () => {
  setup();
  const agent = makeAgent({ id: 'stale', events: [callEvent(1), resultEvent(1)] });
  assert.equal(await run(agent, 1, configDiff('D1')), undefined);

  // 代码改成 D2，本回合没有新的评审调用 → 旧评审不能覆盖新 diff
  const text = await run(agent, 2, configDiff('D2'));
  assert.ok(text, '审完又改必须再拦');
  assert.equal(statusOf('stale').last.reason, 'stale');

  // 正向：改了之后重新评审一次（新 callId）→ 放行
  agent.session.snapshotEvents = () => [
    callEvent(1, 'c1'), resultEvent(1, 'c1'),
    callEvent(2, 'c2'), resultEvent(2, 'c2'),
  ];
  assert.equal(await run(agent, 2, configDiff('D2')), undefined, '认真重审过就必须放行');
  assert.equal(statusOf('stale').last.reason, 'ok');
});

// ---------------------------------------------------------------- 7. 子 Agent

test('7. 子 Agent 发起的 summon → 不算证据（门禁不判它，也不把 reviewed 记成 true）', async () => {
  setup();
  const sub = makeAgent({ id: 'sub', depth: 1, events: [callEvent(1), resultEvent(1)] });
  assert.equal(await run(sub), undefined, '子 Agent 不参与门禁：它没有计入证据的评审载体，再拦就是无限推回');
  assert.equal(sub.steered.length, 0);
  assert.notEqual(statusOf('sub').last?.reviewed, true, '子 Agent 的评审不得被记成「已评审」');

  // 正向对照：完全相同的证据放在主会话 → 必须被接受
  const main = makeAgent({ id: 'main', depth: 0, events: [callEvent(1), resultEvent(1)] });
  await run(main);
  assert.equal(statusOf('main').last.reviewed, true);
});

test('7b. 子 Agent 的评审不能给主会话顶账（两个会话各自记账）', async () => {
  setup();
  const sub = makeAgent({ id: 'sub-2', depth: 2, events: [callEvent(1), resultEvent(1)] });
  await run(sub);
  const main = makeAgent({ id: 'main-2', depth: 0, events: [] });
  assert.ok(await run(main), '主会话不能继承子 Agent 的评审');
  assert.equal(statusOf('main-2').last.reason, 'no-call');
});
