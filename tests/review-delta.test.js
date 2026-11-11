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
