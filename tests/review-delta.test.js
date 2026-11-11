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
