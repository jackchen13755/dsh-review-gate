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

// 2026-11-11 多仓库：工作区根常是多个独立仓库的父目录（本机实测 21 个），
// 一个会话可以同时改两个仓库。行为契约是「审主范围 + 明确报出其余未覆盖」，
// 而不是静默只审一个、让用户以为全覆盖了。
test('跨仓库会话：statusOf 报出全部仓库根，主范围取最近写入的那个', async () => {
  setup();
  const agent = makeAgent();
  const lines = [];
  const roots = ['/work/repoA', '/work/repoB'];
  await handleTurnStopping(
    { agent, turn: 1 },
    {
      collectDiff: async root => configDiff(`R-${root}`),
      readJournal: journalUnknown,
      runCommand: async (line) => { lines.push(line); return { kind: 'success' }; },
      repoRoots: async () => roots,
      gitRoot: async () => '/work',
    },
  );
  const st = statusOf('s1');
  assert.deepEqual(st.repos, roots, '两个仓库都必须被报出来');
  assert.equal(st.spanning, true, '跨仓库必须显式标记，否则会被误读成全部审过');
  assert.ok(lines.some(l => l.includes('/work/repoA')), '主范围必须是 repos[0]（最近在改的那个）');
});

test('单仓库会话：spanning=false，不制造噪音', async () => {
  setup();
  const agent = makeAgent();
  await handleTurnStopping(
    { agent, turn: 1 },
    {
      collectDiff: async () => configDiff('S1'),
      readJournal: journalUnknown,
      runCommand: async () => ({ kind: 'success' }),
      repoRoots: async () => ['/work/only'],
      gitRoot: async () => '/work',
    },
  );
  const st = statusOf('s1');
  assert.deepEqual(st.repos, ['/work/only']);
  assert.equal(st.spanning, false);
});

/**
 * R3：同一棵树、同一份 diff，两个会话各自都要评审，不能互相顶账。
 *
 * 这条守的是「串评审」最隐蔽的形态：如果 reviewed 标记只按 diff 摘要记，
 * 那么会话 A 审完，会话 B（同样改这棵树、但意图完全不同）就会被判成「已评审」而静默跳过。
 * 宿主强制 agent.id === session.id，所以按会话 id 记账是可行的；这里把它钉住。
 */
test('同树两会话不互相顶账：各自都要发起一次评审', async () => {
  setup();
  const lines = [];
  const deps = {
    collectDiff: async () => configDiff('SAME-TREE'),   // 注意：摘要完全相同
    readJournal: journalUnknown,
    runCommand: async (line) => { lines.push(line); return { kind: 'success' }; },
    repoRoots: async () => ['/work/repoA'],
    gitRoot: async () => '/work/repoA',
  };
  // 会话 A 先发起评审，然后拿到一份**成功报告**——这一刻 A 才真的被记为「已评审」。
  // 必须走到这一步，否则「已评审」分支根本没被触发，全局记账的错误实现也测不出来。
  const reportEvents = [{ type: 'user/message', data: {
    content: [{ type: 'text', text: 'Here is the completed code review report:\n\nok' }],
    source: { kind: 'michengai-code-review' },
  } }];
  await handleTurnStopping({ agent: makeAgent({ id: 'sA' }), turn: 1 }, deps);
  await handleTurnStopping({ agent: makeAgent({ id: 'sA', events: reportEvents }), turn: 1 }, deps);
  const beforeB = lines.length;
  // 会话 B：同一棵树、同一个 diff 摘要，但意图完全不同 → 必须再发起一次。
  await handleTurnStopping({ agent: makeAgent({ id: 'sB' }), turn: 1 }, deps);
  assert.equal(lines.length, beforeB + 1, 'B 不能被 A 的评审记录顶账（同树不同会话）');
});

test('同一会话同一摘要的重复回合不重复评审（单飞仍然成立）', async () => {
  setup();
  const lines = [];
  const agent = makeAgent({ id: 'same' });
  const deps = {
    collectDiff: async () => configDiff('REPEAT'),
    readJournal: journalUnknown,
    runCommand: async (line) => { lines.push(line); return { kind: 'success' }; },
    repoRoots: async () => ['/work/repoA'],
    gitRoot: async () => '/work/repoA',
  };
  await handleTurnStopping({ agent, turn: 1 }, deps);
  await handleTurnStopping({ agent, turn: 1 }, deps);
  assert.equal(lines.length, 1, '同一会话同一摘要不该重复触发');
});
