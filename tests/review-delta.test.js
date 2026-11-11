/**
 * R16 复审范围收窄：评审后发现的问题改完，再次评审**只针对变了的文件**。
 *
 * 两层验证：
 *   1. 纯函数 deltaScope 的判定表（无基线 / 未变 / 只变 added / 只变 removed /
 *      新增 / 删除 / 空 current / 脏输入不抛）；
 *   2. 集成：走真实 handleTurnStopping，确认 gate 记下基线、第二次判定把范围写进
 *      statusOf().reviewScope 并把「不许全量重审」写进 hint。
 *
 * 每条都要求能红：把 lib/review-delta.js 里签名比较改成恒等（永远相等）后，
 * 「只变 added」「只变 removed」「混合」三类必须失败——见交付说明里的变异证据。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { applyConfig } from '../lib/config.js';
import { clearGateState, handleTurnStopping, statusOf } from '../lib/gate.js';
import { deltaScope } from '../lib/review-delta.js';
import { clearObserved, recordWrite } from '../lib/observed.js';
import { LIMITS } from '../lib/bounded.js';

// ---------------------------------------------------------------- 纯函数

/** collectDiff 的文件项形状。 */
const file = (path, added = [], removed = [], status = 'M') => ({ path, status, added, removed });

/** collectDiff 的 diff 形状（纯函数只读 files）。 */
const diff = (...files) => ({ available: true, digest: 'D', files, totals: { added: 0, removed: 0 } });

test('无 previous（undefined / null / 非对象 / files 非数组 / files 为空）→ 全量', () => {
  const current = diff(file('a.js', ['+a']));
  for (const previous of [
    undefined,
    null,
    42,
    'x',
    {},
    { files: 'not-an-array' },
    { files: [] },
    // 全部元素缺 path：等于没有可用基线，不能当成「每个文件都是新增」
    { files: [{ added: ['+a'] }, { path: '', added: [] }] },
  ]) {
    assert.deepEqual(
      deltaScope(previous, current),
      { mode: 'full', files: [], reason: 'no-previous' },
      `previous=${JSON.stringify(previous)} 必须退化为全量`,
    );
  }
});

test('完全相同 → narrow / unchanged / 空文件集', () => {
  const same = [file('a.js', ['+1', '+2'], ['-3']), file('b.js', ['+4'])];
  assert.deepEqual(deltaScope(diff(...same), diff(...same)), {
    mode: 'narrow',
    files: [],
    reason: 'unchanged',
  });
});

test('只改 added → 只报这个文件', () => {
  const before = diff(file('a.js', ['+1']), file('b.js', ['+keep']));
  const after = diff(file('a.js', ['+1', '+2']), file('b.js', ['+keep']));
  assert.deepEqual(deltaScope(before, after), {
    mode: 'narrow',
    files: ['a.js'],
    reason: 'changed',
  });
});

test('只改 removed → 只报这个文件', () => {
  const before = diff(file('a.js', [], ['-1']));
  const after = diff(file('a.js', [], ['-1', '-2']));
  assert.deepEqual(deltaScope(before, after), {
    mode: 'narrow',
    files: ['a.js'],
    reason: 'changed',
  });
});

test('新增文件（基线里没有）→ 计入新增文件', () => {
  const before = diff(file('a.js', ['+1']));
  const after = diff(file('a.js', ['+1']), file('new.js', ['+n']));
  assert.deepEqual(deltaScope(before, after), {
    mode: 'narrow',
    files: ['new.js'],
    reason: 'changed',
  });
});

test('删除文件（current 里没有）→ 也必须复审', () => {
  const before = diff(file('a.js', ['+1']), file('old.js', ['+x']));
  const after = diff(file('a.js', ['+1']));
  assert.deepEqual(deltaScope(before, after), {
    mode: 'narrow',
    files: ['old.js'],
    reason: 'changed',
  });
});

test('空 current（files 为空数组 / undefined）→ 基线里的文件全部算变更', () => {
  const before = diff(file('b.js', ['+b']), file('a.js', ['+a']), file('c.js', ['+c']));
  for (const after of [{ files: [] }, undefined, null]) {
    assert.deepEqual(
      deltaScope(before, after),
      { mode: 'narrow', files: ['a.js', 'b.js', 'c.js'], reason: 'changed' },
      `current=${JSON.stringify(after)} 时不能谎称「没有改动」`,
    );
  }
});

test('混合场景：只含变了的文件（含新增/删除），且按字典序', () => {
  const before = diff(file('a.js', ['+1']), file('b.js', ['+b']), file('c.js', ['+c']));
  const after = diff(
    file('a.js', ['+1', '+changed']), // 变了
    file('b.js', ['+b']), // 没变 → 不能出现在结果里
    file('d.js', ['+d']), // 新增
  );
  const result = deltaScope(before, after);
  assert.deepEqual(result, { mode: 'narrow', files: ['a.js', 'c.js', 'd.js'], reason: 'changed' });
  assert.ok(!result.files.includes('b.js'), '没变的文件不得进入复审范围（全量重审的口子）');
});

test('脏输入不抛：current 形状坏掉时按「看不到文件」处理', () => {
  const before = diff(file('a.js', ['+1']));
  for (const after of [
    undefined,
    null,
    'x',
    42,
    {},
    { files: 'not-an-array' },
    { files: [null, {}, { path: 42 }, { path: '', added: ['+x'] }] },
    { files: [{ path: 'ok.js', added: 'not-an-array', removed: 7 }] },
  ]) {
    const result = deltaScope(before, after);
    assert.equal(result.mode, 'narrow', `current=${JSON.stringify(after)} 时不该抛`);
    assert.ok(Array.isArray(result.files));
  }
  // 有 path 的那一项必须被算进来（added 非数组按空处理）
  assert.deepEqual(
    deltaScope(before, { files: [{ path: 'ok.js', added: 'not-an-array' }] }).files,
    ['a.js', 'ok.js'],
  );
});

test('status 变化但内容不变 → 不算变更（只有内容才是复审依据）', () => {
  const before = diff(file('a.js', ['+1'], [], 'M'));
  const after = diff(file('a.js', ['+1'], [], 'A'));
  assert.deepEqual(deltaScope(before, after), { mode: 'narrow', files: [], reason: 'unchanged' });
});

// ---------------------------------------------------------------- 集成（真实 handleTurnStopping）

function makeAgent({ id = 's1', events = [], cwd = '/tmp/work' } = {}) {
  const steered = [];
  return {
    id,
    steered,
    session: { header: { cwd, delegationDepth: 0 }, snapshotEvents: () => events },
    steer: (m) => steered.push(m),
  };
}

const callEvent = (turn, callId = 'c1') => ({
  type: 'tool/call',
  data: { turn, step: 1, callId, name: 'dsh_code_review', arguments: '{}' },
});
const resultEvent = (turn, callId = 'c1') => ({
  type: 'tool/result',
  data: { turn, step: 2, message: { role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text: '完成' }] } },
});

const journalUnknown = async () => ({ verdict: 'unknown' });

/** 会触发门禁的 diff：改了根级 package.json。 */
const reviewDiff = (digest, ...files) => ({
  available: true,
  digest,
  files,
  totals: { added: 1, removed: 0 },
});

function setup() {
  clearGateState();
  applyConfig({ gate: true, gateMaxSteersPerTurn: 1, gateMaxSteersPerSession: 3, steer: true });
}

test('集成：评审后只改一个文件 → reviewScope 收窄到该文件，hint 不许全量重审', async () => {
  setup();
  const unchanged = file('src/a.js', ['// 没动过']);
  const firstDiff = () => reviewDiff('D1', file('package.json', ['  "x": 1']), unchanged);

  const agent1 = makeAgent({ events: [callEvent(1), resultEvent(1)] });
  await handleTurnStopping(
    { agent: agent1, turn: 1 },
    { collectDiff: firstDiff, readJournal: journalUnknown },
  );
  assert.equal(statusOf('s1').last?.reviewed, true, '前置：第一回合必须真的记为已评审（否则没有基线）');
  assert.equal(statusOf('s1').reviewScope, null, '首次评审没有基线，不应凭空给一个收窄范围');

  // 第 2 回合：只改了 package.json，src/a.js 原样；本回合没有新的评审调用
  const agent2 = makeAgent({ events: [callEvent(1), resultEvent(1)] });
  const text = await handleTurnStopping(
    { agent: agent2, turn: 2 },
    { collectDiff: async () => reviewDiff('D2', file('package.json', ['  "x": 2']), unchanged), readJournal: journalUnknown },
  );

  const status = statusOf('s1');
  assert.ok(text, '改过之后仍要拦（收窄范围不等于放行）');
  assert.equal(status.last.needsAgentReview, true);
  assert.deepEqual(status.reviewScope, { mode: 'narrow', files: ['package.json'], reason: 'changed' });
  assert.match(status.last.hint, /1 个文件/);
  assert.match(status.last.hint, /package\.json/);
  assert.match(status.last.hint, /不要全量重审/);
});

test('集成：文件签名没变（只有 digest 变）→ files 为空且 hint 说无需再次评审', async () => {
  setup();
  const sameFiles = () => reviewDiff('D1', file('package.json', ['  "x": 1']));

  const agent1 = makeAgent({ events: [callEvent(1), resultEvent(1)] });
  await handleTurnStopping(
    { agent: agent1, turn: 1 },
    { collectDiff: sameFiles, readJournal: journalUnknown },
  );
  assert.equal(statusOf('s1').last?.reviewed, true);

  // 同内容的文件、不同 digest：digest 判「不是同一版」，但没有任何文件内容变化
  const agent2 = makeAgent({ events: [callEvent(1), resultEvent(1)] });
  await handleTurnStopping(
    { agent: agent2, turn: 2 },
    { collectDiff: async () => reviewDiff('D2', file('package.json', ['  "x": 1'])), readJournal: journalUnknown },
  );

  const status = statusOf('s1');
  assert.deepEqual(status.reviewScope, { mode: 'narrow', files: [], reason: 'unchanged' });
  assert.match(status.last.hint, /无需再次评审/);
});

test('集成：变更文件超过 10 个 → hint 只点名 10 个并用「另有 M 个」补齐', async () => {
  setup();
  // 11 个新增文件 + 改过的 package.json = 12 个变更文件（既有基线里被删掉的那一个不算，因为还在）
  const many = (extra) => Array.from({ length: 11 }, (_, i) => file(`f${String(i).padStart(2, '0')}.js`, [extra]));

  const agent1 = makeAgent({ events: [callEvent(1), resultEvent(1)] });
  await handleTurnStopping(
    { agent: agent1, turn: 1 },
    { collectDiff: async () => reviewDiff('D1', file('package.json', ['  "x": 1'])), readJournal: journalUnknown },
  );
  assert.equal(statusOf('s1').last?.reviewed, true);

  // 11 个文件全是新增 + package.json 内容变了 → 12 个都在复审范围内，hint 只列 10 个
  const agent2 = makeAgent({ events: [callEvent(1), resultEvent(1)] });
  await handleTurnStopping(
    { agent: agent2, turn: 2 },
    { collectDiff: async () => reviewDiff('D2', file('package.json', ['  "x": 2']), ...many('+x')), readJournal: journalUnknown },
  );

  const status = statusOf('s1');
  assert.equal(status.reviewScope.mode, 'narrow');
  assert.equal(status.reviewScope.files.length, 12);
  assert.match(status.last.hint, /12 个文件/);
  assert.match(status.last.hint, /另有 2 个/, '超过 10 个的部分必须折成数量');
  assert.match(status.last.hint, /不要全量重审/);
});

// ------------------------------------------------- 复审范围的写入时机与生命周期（R16 修正）
//
// 上面三条集成用例只覆盖「算得对」。下面三条覆盖「什么时候算、什么时候清」：
//   a) 一条触发规则都没命中 → 根本不需要评审 → 不许留下 reviewScope；
//   b) 有基线、真要评审 → narrow 且只含真正变了的那个文件；
//   c) 这一轮评审完成后 → reviewScope 被消费掉，基线同时前移。

test('集成：未命中任何触发规则的回合 → 不得凭基线写出 reviewScope', async () => {
  setup();
  // 先造一次成功评审：没有基线的话 reviewScope 本来就不会被算出来，这条就测不到。
  const agent1 = makeAgent({ events: [callEvent(1), resultEvent(1)] });
  await handleTurnStopping(
    { agent: agent1, turn: 1 },
    { collectDiff: async () => reviewDiff('D1', file('package.json', ['  "x": 1'])), readJournal: journalUnknown },
  );
  assert.equal(statusOf('s1').last?.reviewed, true, '前置：必须先有一次成功评审，否则没有基线');

  // 第 2 回合：只改了一行注释（不命中任何触发规则），也没调评审。
  const agent2 = makeAgent({ events: [] });
  await handleTurnStopping(
    { agent: agent2, turn: 2 },
    { collectDiff: async () => reviewDiff('D2', file('src/a.js', ['// 只改了一行注释'])), readJournal: journalUnknown },
  );

  const status = statusOf('s1');
  assert.deepEqual(status.last.reasons, [], '前置：这条改动确实不命中触发规则（否则测的是另一条路径）');
  assert.equal(status.last.needsAgentReview, undefined, '前置：没进入「需要评审」分支');
  assert.equal(
    status.reviewScope,
    null,
    '未被要求评审的会话不该有一个算出来的窄范围（否则 review_gate_status 会凭空显示复审范围）',
  );
});

test('集成：有基线后只改一个文件 → reviewScope 为 narrow 且只含该文件', async () => {
  setup();
  const agent1 = makeAgent({ events: [callEvent(1), resultEvent(1)] });
  await handleTurnStopping(
    { agent: agent1, turn: 1 },
    {
      collectDiff: async () => reviewDiff('D1', file('package.json', ['  "x": 1']), file('src/a.js', ['+one'])),
      readJournal: journalUnknown,
    },
  );
  assert.equal(statusOf('s1').last?.reviewed, true, '前置：第一回合必须记为已评审（否则没有基线）');

  // 第 2 回合：package.json 原样、只有 src/a.js 变了（两个文件都在 diff 里）。
  const agent2 = makeAgent({ events: [] });
  const text = await handleTurnStopping(
    { agent: agent2, turn: 2 },
    {
      collectDiff: async () => reviewDiff('D2', file('package.json', ['  "x": 1']), file('src/a.js', ['+one', '+two'])),
      readJournal: journalUnknown,
    },
  );

  const status = statusOf('s1');
  assert.ok(text, '真要评审时必须真的拦下来（收窄范围不等于放行）');
  assert.equal(status.last.needsAgentReview, true);
  assert.deepEqual(status.reviewScope, { mode: 'narrow', files: ['src/a.js'], reason: 'changed' });
  assert.match(status.last.hint, /src\/a\.js/);
  assert.doesNotMatch(status.last.hint, /package\.json/, '没变的文件不得进复审范围');
});

test('集成：这一轮评审成功后 reviewScope 被清空，基线同时前移', async () => {
  setup();
  // 第 1 轮：package.json(x:1) + src/a.js 全审过 → 基线 = 这两个文件。
  const agent1 = makeAgent({ events: [callEvent(1), resultEvent(1)] });
  await handleTurnStopping(
    { agent: agent1, turn: 1 },
    {
      collectDiff: async () => reviewDiff('D1', file('package.json', ['  "x": 1']), file('src/a.js', ['+one'])),
      readJournal: journalUnknown,
    },
  );
  assert.equal(statusOf('s1').last?.reviewed, true);

  // 第 2 轮：只改 package.json → 算出一个待用的窄范围。
  const agent2 = makeAgent({ events: [] });
  await handleTurnStopping(
    { agent: agent2, turn: 2 },
    {
      collectDiff: async () => reviewDiff('D2', file('package.json', ['  "x": 2']), file('src/a.js', ['+one'])),
      readJournal: journalUnknown,
    },
  );
  assert.deepEqual(
    statusOf('s1').reviewScope,
    { mode: 'narrow', files: ['package.json'], reason: 'changed' },
    '前置：这一轮必须真的产出了窄范围',
  );

  // 第 3 轮：这一轮评审成功 → 窄范围被消费掉。
  const agent3 = makeAgent({ events: [callEvent(3), resultEvent(3)] });
  await handleTurnStopping(
    { agent: agent3, turn: 3 },
    {
      collectDiff: async () => reviewDiff('D2', file('package.json', ['  "x": 2']), file('src/a.js', ['+one'])),
      readJournal: journalUnknown,
    },
  );
  const afterReview = statusOf('s1');
  assert.equal(afterReview.last?.reviewed, true, '前置：第 3 轮必须被判为已评审');
  assert.equal(afterReview.reviewScope, null, '评审完成后窄范围已消费，不能再被当成当前事实报告');

  // 第 4 轮：只改 src/a.js。基线若仍停在 x:1，package.json 也会被算成变更 → 断言会红，
  // 所以「只剩 src/a.js」间接证明了第 3 轮把基线更新成了 x:2。
  const agent4 = makeAgent({ events: [] });
  await handleTurnStopping(
    { agent: agent4, turn: 4 },
    {
      collectDiff: async () => reviewDiff('D4', file('package.json', ['  "x": 2']), file('src/a.js', ['+one', '+two'])),
      readJournal: journalUnknown,
    },
  );
  assert.deepEqual(
    statusOf('s1').reviewScope,
    { mode: 'narrow', files: ['src/a.js'], reason: 'changed' },
    '基线没前移到 x:2 的话，package.json 会一起被算进复审范围',
  );
});

test('集成：确认无改动（空文件集）的回合 → 同样清掉上一轮留下的 reviewScope', async () => {
  setup();
  const agent1 = makeAgent({ events: [callEvent(1), resultEvent(1)] });
  await handleTurnStopping(
    { agent: agent1, turn: 1 },
    {
      collectDiff: async () => reviewDiff('D1', file('package.json', ['  "x": 1']), file('src/a.js', ['+one'])),
      readJournal: journalUnknown,
    },
  );
  assert.equal(statusOf('s1').last?.reviewed, true);

  // 第 2 轮：只改 package.json → 产出待用的窄范围。
  const agent2 = makeAgent({ events: [] });
  await handleTurnStopping(
    { agent: agent2, turn: 2 },
    {
      collectDiff: async () => reviewDiff('D2', file('package.json', ['  "x": 2']), file('src/a.js', ['+one'])),
      readJournal: journalUnknown,
    },
  );
  assert.deepEqual(statusOf('s1').reviewScope, { mode: 'narrow', files: ['package.json'], reason: 'changed' });

  // 第 3 轮：取证成功但确认没有改动 → 这一轮不需要评审，窄范围同样已消费。
  const agent3 = makeAgent({ events: [] });
  await handleTurnStopping(
    { agent: agent3, turn: 3 },
    { collectDiff: async () => reviewDiff('D3'), readJournal: journalUnknown },
  );

  const status = statusOf('s1');
  assert.equal(status.last?.skipped, 'no-diff-evidence', '前置：走的是「确认无改动」早退分支');
  assert.equal(status.reviewScope, null, '本轮明确没有改动，却还报着上一轮的复审范围 = 读到陈旧字段');
});

test('集成：未命中触发规则的回合 → 同样清掉上一轮留下的 reviewScope', async () => {
  setup();
  const unchanged = file('src/a.js', ['+one']);

  // 第 1 轮：评审成功 → 记下基线（package.json + src/a.js）。
  const agent1 = makeAgent({ events: [callEvent(1), resultEvent(1)] });
  await handleTurnStopping(
    { agent: agent1, turn: 1 },
    { collectDiff: async () => reviewDiff('D1', file('package.json', ['  "x": 1']), unchanged), readJournal: journalUnknown },
  );
  assert.equal(statusOf('s1').last?.reviewed, true, '前置：第 1 轮必须真的记为已评审（否则没有基线）');

  // 第 2 轮：只改 package.json → 产出一个待用的窄范围。
  const agent2 = makeAgent({ events: [] });
  await handleTurnStopping(
    { agent: agent2, turn: 2 },
    { collectDiff: async () => reviewDiff('D2', file('package.json', ['  "x": 2']), unchanged), readJournal: journalUnknown },
  );
  assert.deepEqual(
    statusOf('s1').reviewScope,
    { mode: 'narrow', files: ['package.json'], reason: 'changed' },
    '前置：第 2 轮必须真的产出了窄范围',
  );

  // 第 3 轮：只改了一个文档（docs/guide.md）。按现有触发规则，纯文档改动
  // 一条规则都不命中（doc 不参与跨模块、不带 CONFIG/SECURITY/DELETION，
  // 兜底 CODE 规则只对非 doc 文件生效）→ reasons=[]，门禁放行。
  // 这一轮**没有**评审，所以上一轮的窄范围必须被消费掉：否则 agent 会按
  // statusOf().reviewScope 去复审 package.json——而它已不在本轮 diff 里，
  // 真正改了的 docs/guide.md 反而没人看。
  const agent3 = makeAgent({ events: [] });
  const released = await handleTurnStopping(
    { agent: agent3, turn: 3 },
    {
      collectDiff: async () => reviewDiff('D3', file('docs/guide.md', ['补充说明文字'])),
      readJournal: journalUnknown,
    },
  );

  const status = statusOf('s1');
  assert.equal(released, undefined, '门禁必须放行（没有推回）');
  assert.deepEqual(status.last?.reasons, [], '前置：这一轮必须真的走到「未命中触发规则」，而不是别的分支');
  assert.ok(!status.last?.needsAgentReview, '前置：没有命中触发规则就不该要求评审');
  assert.equal(status.last?.reviewed, false, '前置：这一轮没有被评审');
  assert.equal(status.last?.skipped, undefined, '前置：不是 no-diff / other-session-only 这些早退分支');
  assert.equal(
    status.reviewScope,
    null,
    '门禁已放行的一轮里仍报着上一轮的复审范围 = 把复审引到已不在 diff 里的文件',
  );
});

// ---------------------------------------------------------------- I1：早退出口不许留旧 scope
//
// 不变量 I1：每次 turn-stopping 返回前，`reviewScope[sid]` 要么是**本次 diff 算出的**窄范围，
// 要么为空；不得留着上一次的值。
//
// 为什么这不是洁癖：`reviewScope` 是**外部**（`review_gate_status` 工具 / 注入提示）唯一能读到的
// 「这轮该审哪些文件」。下面六个出口都在「重算窄范围」之前 return，它们各自没算范围，
// 却把上一轮的窄范围继续挂在 status 里 —— agent 照着它评审，就会：
//   · 少审本轮真正改了的文件（假放行，最严重）；
//   · 去审已在 diff 里消失的文件（评审工具/人都被带偏）。

const bashCall = (turn, command) => ({
  type: 'tool/call',
  data: { name: 'bash', turn, arguments: JSON.stringify({ command }) },
});

/** 取证的 stub：按 digest 造一版会触发门禁的 diff（改根级 package.json）。 */
const seedDeps = (digest, extra = {}) => ({
  collectDiff: async () =>
    reviewDiff(digest, file('package.json', [`  "x": ${digest}`]), file('src/a.js', ['+one'])),
  gitRoot: async () => undefined,
  readJournal: journalUnknown,
  ...extra,
});

/** 取证失败的 stub（不是 git 工作树，也没有观察记录）。 */
const noDiffDeps = () => ({
  collectDiff: async () => ({ available: false, reason: 'not a git work tree' }),
  gitRoot: async () => undefined,
  readJournal: journalUnknown,
});

/**
 * 造前置：第 1 轮评审成功（写下基线），第 2 轮只改 package.json（算出待用的窄范围）。
 * 返回第 2 轮之后的 status —— 调用方要先断言它确实是「留下了一个窄范围」的前置，
 * 否则后面的断言会因为前置不成立而空转。
 */
async function seedStaleScope(sid) {
  const agent1 = makeAgent({ id: sid, events: [callEvent(1, `c1-${sid}`), resultEvent(1, `c1-${sid}`)] });
  await handleTurnStopping({ agent: agent1, turn: 1 }, seedDeps('D1'));
  const agent2 = makeAgent({ id: sid, events: [] });
  await handleTurnStopping({ agent: agent2, turn: 2 }, seedDeps('D2'));
  return statusOf(sid);
}

const SEEDED_SCOPE = { mode: 'narrow', files: ['package.json'], reason: 'changed' };

/** 六个早退出口：[名字, 本行独用的 sid, 造第 3 轮, 该出口的自我标识断言]。 */
const EXIT_ROWS = [
  {
    name: 'no-cwd',
    sid: 'exit-no-cwd',
    async turn3(sid) {
      // 会话拿不到目录（实时值与 header 都缺失）→ 放弃取证
      const agent = makeAgent({ id: sid, cwd: null, events: [] });
      await handleTurnStopping({ agent, turn: 3 }, seedDeps('D3'));
    },
    check(last) {
      assert.equal(last?.skipped, 'no-cwd', '前置：这一轮必须走的是 no-cwd 出口');
    },
  },
  {
    name: 'no-events',
    sid: 'exit-no-events',
    async turn3(sid) {
      // 读不到会话日志 → 无法判定是否评审过
      const agent = {
        id: sid,
        steered: [],
        session: { header: { cwd: '/tmp/work', delegationDepth: 0 } },
        steer() {},
      };
      await handleTurnStopping({ agent, turn: 3 }, seedDeps('D3'));
    },
    check(last) {
      assert.equal(last?.skipped, 'no-events', '前置：这一轮必须走的是 no-events 出口');
    },
  },
  {
    name: 'no-diff',
    sid: 'exit-no-diff',
    async turn3(sid) {
      const agent = makeAgent({ id: sid, events: [] });
      await handleTurnStopping({ agent, turn: 3 }, noDiffDeps());
    },
    check(last) {
      assert.equal(last?.skipped, 'no-diff', '前置：这一轮必须走的是 no-diff 出口');
    },
  },
  {
    name: 'other-session-only',
    sid: 'exit-other-session',
    async turn3(sid) {
      // 观察记录里只有别的文件的写入 → 本次 diff 全部不属于本会话
      recordWrite(sid, '/tmp/work/only-mine.js');
      const agent = makeAgent({ id: sid, events: [] });
      await handleTurnStopping({ agent, turn: 3 }, seedDeps('D3'));
      clearObserved(sid);
    },
    check(last) {
      assert.equal(last?.skipped, 'other-session-only', '前置：这一轮必须走的是 other-session-only 出口');
    },
  },
  {
    name: 'ops-only',
    sid: 'exit-ops-only',
    async turn3(sid) {
      // 只做了 git commit → 本回合免评审
      const agent = makeAgent({ id: sid, events: [bashCall(3, 'git commit -m "x"')] });
      await handleTurnStopping({ agent, turn: 3 }, seedDeps('D3'));
    },
    check(last) {
      assert.equal(last?.skipped, 'ops-only', '前置：这一轮必须走的是 ops-only 出口');
    },
  },
  {
    name: 'digest-same',
    sid: 'exit-digest-same',
    async turn3(sid) {
      // 与第 1 轮评审过的完全同一版 → 已评审，无需再审
      const agent = makeAgent({ id: sid, events: [] });
      await handleTurnStopping({ agent, turn: 3 }, seedDeps('D1'));
    },
    check(last) {
      assert.equal(last?.skipped, 'already-reviewed', '前置：这一轮必须走的是 digest 相同的出口');
    },
  },
];

for (const row of EXIT_ROWS) {
  test(`S1 出口「${row.name}」不得把上一轮的 reviewScope 当本轮事实留着`, async () => {
    setup();
    const seeded = await seedStaleScope(row.sid);
    assert.deepEqual(seeded.reviewScope, SEEDED_SCOPE, '前置：上一轮必须真的留下了一个待用的窄范围');

    await row.turn3(row.sid);
    const after = statusOf(row.sid);
    assert.equal(
      after.reviewScope,
      null,
      `「${row.name}」这一轮没有算出任何窄范围 → reviewScope 必须是空，不能留着上一轮的值（I1）`,
    );
    row.check(after.last);
  });
}

test('S3 digest 相同也要清 scope，并把 lastStatus 从「上一轮要求评审」改写成「已评审」', async () => {
  setup();
  const sid = 'digest-same-status';
  await seedStaleScope(sid);
  const before = statusOf(sid);
  assert.deepEqual(before.reviewScope, SEEDED_SCOPE, '前置：上一轮留下窄范围');
  assert.equal(before.last?.needsAgentReview, true, '前置：上一轮的外部状态是「需要评审」');

  const agent3 = makeAgent({ id: sid, events: [] });
  const text = await handleTurnStopping({ agent: agent3, turn: 3 }, seedDeps('D1'));

  const after = statusOf(sid);
  assert.equal(text, undefined, '已评审过的同一版改动不该再把回合拉回去');
  assert.equal(after.reviewScope, null, 'digest 相同的这一轮没有窄范围 → 必须清掉');
  assert.equal(after.last?.skipped, 'already-reviewed', '必须写明为什么放行');
  assert.equal(after.last?.reviewed, true, '外部读到的事实必须是「已评审」');
  assert.equal(after.last?.digest, 'D1', '要写出是哪一版 diff 已评审（digest 前 12 位）');
  assert.equal(
    after.last?.needsAgentReview,
    undefined,
    '外部若还读到 needsAgentReview=true，就会把「已评审」当「待评审」再拉一次',
  );
});

test('S4b 兜底 catch 出口：门禁自己抛错，也必须清 reviewScope 并写出可区分的 gate-error', async () => {
  setup();
  const sid = 'gate-error-cleanup';
  await seedStaleScope(sid);
  const before = statusOf(sid);
  assert.deepEqual(before.reviewScope, SEEDED_SCOPE, '前置：上一轮必须真的留下了待用的窄范围');
  assert.equal(before.last?.needsAgentReview, true, '前置：上一轮的外部状态是「需要评审」');

  // 第 3 轮：取证直接抛错 = 门禁自身的故障，不是「按设计放行」。
  const agent3 = makeAgent({ id: sid, events: [] });
  const text = await handleTurnStopping(
    { agent: agent3, turn: 3 },
    {
      collectDiff: async () => { throw new Error('gate-boom'); },
      gitRoot: async () => undefined,
      readJournal: journalUnknown,
    },
  );

  assert.equal(text, undefined, '门禁自己坏掉绝不能把回合卡死（放行行为不变）');
  const after = statusOf(sid);
  assert.equal(after.reviewScope, null, 'I1 也管这条出口：抛错这一轮没算出窄范围 → 上一轮的必须作废');
  assert.equal(after.last?.skipped, 'gate-error', '外部要能区分「按设计放行」与「门禁自己坏了」');
  assert.match(String(after.last?.error), /gate-boom/, '状态里要带错误简述，否则排障只能靠猜');
  assert.equal(
    after.last?.needsAgentReview,
    undefined,
    '不许继续显示上一轮的「待评审」——那会把「门禁坏了」读成「等着评审」',
  );
});

test('S2 no-diff 只清 reviewScope，不弃用基线（取证恢复后仍算出同样窄范围）', async () => {
  setup();
  const sid = 'nodiff-keeps-basis';
  await seedStaleScope(sid);
  assert.deepEqual(statusOf(sid).reviewScope, SEEDED_SCOPE, '前置：上一轮留下窄范围');

  const agent3 = makeAgent({ id: sid, events: [] });
  await handleTurnStopping({ agent: agent3, turn: 3 }, noDiffDeps());
  const afterNoDiff = statusOf(sid);
  assert.equal(afterNoDiff.last?.skipped, 'no-diff', '前置：第 3 轮走的是 no-diff 出口');
  assert.equal(afterNoDiff.reviewScope, null, 'no-diff 这一轮没算出范围 → 不许留着上一轮的');

  // 第 4 轮：取证恢复，仍是第 2 轮那一版 diff。基线若被 no-diff 顺手弃用，这里就退化成全量。
  const agent4 = makeAgent({ id: sid, events: [] });
  await handleTurnStopping({ agent: agent4, turn: 4 }, seedDeps('D2'));
  const afterRecover = statusOf(sid);
  assert.equal(afterRecover.last?.needsAgentReview, true, '前置：第 4 轮必须走到「需要评审」');
  assert.deepEqual(
    afterRecover.reviewScope,
    SEEDED_SCOPE,
    '基线必须还在：no-diff 只清 scope，不动 reviewBasis',
  );
});

test('S4 budget-exhausted 的 scope 是本次重算值（构造跨回合）', async () => {
  clearGateState();
  applyConfig({ gate: true, gateMaxSteersPerTurn: 1, gateMaxSteersPerSession: 1, steer: true });
  const sid = 'budget-scope';
  const deps = (digest, extraFile) => ({
    collectDiff: async () =>
      reviewDiff(
        digest,
        file('package.json', [`  "x": ${digest}`]),
        file('src/a.js', extraFile ? ['+one', '+two'] : ['+one']),
      ),
    gitRoot: async () => undefined,
    readJournal: journalUnknown,
  });

  // 第 1 轮：评审成功 → 基线
  const agent1 = makeAgent({ id: sid, events: [callEvent(1), resultEvent(1)] });
  await handleTurnStopping({ agent: agent1, turn: 1 }, deps('D1', false));
  assert.equal(statusOf(sid).last?.reviewed, true, '前置：第 1 轮必须记为已评审');

  // 第 2 轮：只改 package.json → 窄范围 + 用掉本会话唯一的 steer 预算
  const agent2 = makeAgent({ id: sid, events: [] });
  await handleTurnStopping({ agent: agent2, turn: 2 }, deps('D2', false));
  assert.deepEqual(statusOf(sid).reviewScope, SEEDED_SCOPE, '前置：第 2 轮留下窄范围并耗尽预算');

  // 第 3 轮：src/a.js 也变了 → 本次应重算成两个文件；预算已耗尽，门禁不再推回
  const agent3 = makeAgent({ id: sid, events: [] });
  await handleTurnStopping({ agent: agent3, turn: 3 }, deps('D3', true));
  const after = statusOf(sid);
  assert.equal(after.last?.reason, 'budget-exhausted', '前置：这一轮必须走的是预算耗尽出口');
  assert.equal(after.last?.admittedByBudget, true, '前置：同上');
  assert.deepEqual(
    after.reviewScope,
    { mode: 'narrow', files: ['package.json', 'src/a.js'], reason: 'changed' },
    '预算耗尽只是不推回回合；scope 仍必须是本次 diff 算出来的值，不是上一轮那两个文件之外的东西',
  );
});

test('S6 基线被淘汰而 scope 残留 → 下一次判定必须清掉（不许拿孤儿 scope 当事实）', async () => {
  setup();
  const sid = 'evict-basis';
  await seedStaleScope(sid);
  assert.deepEqual(statusOf(sid).reviewScope, SEEDED_SCOPE, '前置：本会话留下了窄范围');

  // 用别的会话把 reviewBasis 顶到上限，逼它 FIFO 淘汰本会话的基线（我们这条最老）。
  // 只让它们写基线、不写 scope：这样本会话的 scope 不会被顺手挤掉，前置才站得住。
  for (let i = 0; i < LIMITS.sessions + 1; i += 1) {
    const filler = `evict-filler-${i}`;
    const agent = makeAgent({ id: filler, events: [callEvent(1, `c${i}`), resultEvent(1, `c${i}`)] });
    await handleTurnStopping({ agent, turn: 1 }, seedDeps(`F${i}`));
  }
  assert.deepEqual(
    statusOf(sid).reviewScope,
    SEEDED_SCOPE,
    '前置：本会话的 scope 还在（只有基线被挤掉），否则这条用例是空转',
  );

  // 下一轮：同一版 diff。基线已不在 → 收窄不了 → 必须按全量，并把残留的窄范围清掉。
  const agent3 = makeAgent({ id: sid, events: [] });
  const text = await handleTurnStopping({ agent: agent3, turn: 3 }, seedDeps('D2'));
  // 用 steer 的返回值证明「真的走到了需要评审」（这个会话的 lastStatus 已被 500 个别的会话挤出内存）
  assert.equal(typeof text, 'string', '前置：这一轮必须走到「需要评审」');
  const after = statusOf(sid);
  assert.equal(
    after.reviewScope,
    null,
    '基线缺失时既不能收窄，也不能把上一轮遗留的窄范围留下来当本轮事实',
  );
});

test('S7 ops-only 之后旧 scope 必须清掉（免评审的一轮不报上一轮的范围）', async () => {
  setup();
  const sid = 'ops-only-clears';
  await seedStaleScope(sid);
  assert.deepEqual(statusOf(sid).reviewScope, SEEDED_SCOPE, '前置：上一轮留下窄范围');

  const agent3 = makeAgent({ id: sid, events: [bashCall(3, 'git add -A'), bashCall(3, 'git push origin main')] });
  await handleTurnStopping({ agent: agent3, turn: 3 }, seedDeps('D3'));
  const after = statusOf(sid);
  assert.equal(after.last?.skipped, 'ops-only', '前置：这一轮必须走的是 ops-only 出口');
  assert.equal(after.reviewScope, null, 'ops-only 没有窄范围可言 → 上一轮的值必须清掉');
});
