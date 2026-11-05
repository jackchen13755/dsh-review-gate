import test from 'node:test';
import assert from 'node:assert/strict';

import { decideReview } from '../lib/verdict.js';
import { interpretJournal, ACCEPT_STATUSES, REJECT_STATUSES, journalPathFor } from '../lib/journal.js';
import { eventsOf, findCalls, resultOkFor, reviewCallInTurn } from '../lib/replay.js';

// ---------------------------------------------------------------- verdict

test('四条件全过：算已评审', () => {
  const r = decideReview({ callSeen: true, resultOk: true, journalVerdict: 'accept', digestFresh: true });
  assert.equal(r.reviewed, true);
  assert.equal(r.reason, 'ok');
});

test('谎报一：完全没有调用', () => {
  const r = decideReview({ callSeen: false });
  assert.equal(r.reviewed, false);
  assert.equal(r.reason, 'no-call');
});

test('谎报二：调用了但该次调用失败', () => {
  const r = decideReview({ callSeen: true, resultOk: false, journalVerdict: 'accept' });
  assert.equal(r.reviewed, false);
  assert.equal(r.reason, 'call-failed');
});

test('回归：journal 说 finished 但结果状态是不通过', () => {
  // 第三方插件会先写 finished 再抛错，所以 finished 本身不能当通过
  const r = decideReview({ callSeen: true, resultOk: true, journalVerdict: 'reject' });
  assert.equal(r.reviewed, false);
  assert.equal(r.reason, 'journal-rejected');
});

test('谎报三：评审之后又改了代码（摘要不再新鲜）', () => {
  const r = decideReview({ callSeen: true, resultOk: true, journalVerdict: 'accept', digestFresh: false });
  assert.equal(r.reviewed, false);
  assert.equal(r.reason, 'stale');
});

test('事件源不可得：fail-open 放行，且原因可区分', () => {
  const r = decideReview({ eventsAvailable: false, callSeen: false });
  assert.equal(r.reviewed, true);
  assert.equal(r.reason, 'undetermined-events');
});

test('journal 未知（读不到）：不否决，交给调用事实判定', () => {
  const ok = decideReview({ callSeen: true, resultOk: true, journalVerdict: 'unknown' });
  assert.equal(ok.reviewed, true, '读不到 journal 不该否决一次真实调用');
  const bad = decideReview({ callSeen: false, journalVerdict: 'unknown' });
  assert.equal(bad.reviewed, false, '但没有调用仍然要拦');
});

// ---------------------------------------------------------------- journal

test('interpretJournal：只有 finished + 通过态才算 accept', () => {
  assert.equal(interpretJournal({ state: 'finished', result: { status: 'completed-clean' } }), 'accept');
  assert.equal(interpretJournal({ state: 'finished', result: { status: 'completed-findings' } }), 'accept');
  assert.equal(interpretJournal({ state: 'finished', result: { status: 'failed' } }), 'reject');
  assert.equal(interpretJournal({ state: 'finished', result: { status: 'interrupted' } }), 'reject');
  assert.equal(interpretJournal({ state: 'running' }), 'reject', '还在跑 = 本轮没有完成评审');
  assert.equal(interpretJournal({ state: 'finished' }), 'unknown', '没有 result 不猜');
  assert.equal(interpretJournal(null), 'unknown');
  assert.equal(interpretJournal({ state: 'weird' }), 'unknown');
});

test('ACCEPT 与 REJECT 两个集合不重叠（防止状态被同时判成通过和失败）', () => {
  for (const s of ACCEPT_STATUSES) assert.equal(REJECT_STATUSES.has(s), false, `${s} 不该同时出现在 reject 里`);
});

test('journal 路径按 agent.id 做 sha256 且稳定', () => {
  const a = journalPathFor('agent-1');
  const b = journalPathFor('agent-1');
  assert.equal(a, b);
  assert.match(a, /code-review\/[0-9a-f]{64}\.json$/);
  assert.notEqual(journalPathFor('agent-2'), a);
});

// ---------------------------------------------------------------- replay

const callEvent = (turn, name = 'dsh_code_review', callId = 'c1') => ({
  type: 'tool/call',
  data: { turn, step: 1, callId, name, arguments: '{}' },
});

const resultEvent = (callId = 'c1', text = 'ok') => ({
  type: 'tool/result',
  data: { turn: 1, step: 2, message: { role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text }] } },
});

test('eventsOf：三种形态按序取，且区分「不可得」与「空」', () => {
  assert.deepEqual(eventsOf({ snapshotEvents: () => [1] }), { events: [1], available: true, source: 'snapshotEvents()' });
  assert.deepEqual(eventsOf({ events: [] }), { events: [], available: true, source: 'events' });
  const none = eventsOf({});
  assert.equal(none.available, false, '拿不到事件源必须与「空数组」区分开');
});

test('findCalls：按回合精确匹配，不把别的回合算进来', () => {
  const events = [callEvent(1), callEvent(2, 'dsh_code_review', 'c2'), callEvent(1, 'bash', 'c3')];
  assert.equal(findCalls(events, { turn: 1 }).length, 1);
  assert.equal(findCalls(events, { turn: 1 })[0].callId, 'c1');
  assert.equal(findCalls(events, { turn: 9 }).length, 0);
  // turn 缺失时退化为整会话匹配
  assert.equal(findCalls(events, {}).length, 2, '两个 review 调用都应被找到，bash 不算');
});

test('resultOkFor：失败信号能被识别（含 REVIEW_FAILED 文本）', () => {
  assert.equal(resultOkFor([resultEvent('c1', '一切正常')], 'c1'), true);
  assert.equal(resultOkFor([resultEvent('c1', 'REVIEW_FAILED: 子模型挂了')], 'c1'), false);
  assert.equal(resultOkFor([], 'c1'), null, '找不到结果要返回 null 而不是 false');
  assert.equal(resultOkFor([resultEvent('c1')], ''), null);
});

test('reviewCallInTurn：失败的调用不算数', () => {
  const failed = [callEvent(1), resultEvent('c1', 'REVIEW_FAILED')];
  assert.equal(reviewCallInTurn(failed, { turn: 1 }).seen, false);

  const ok = [callEvent(1), resultEvent('c1', '完成')];
  assert.equal(reviewCallInTurn(ok, { turn: 1 }).seen, true);
});
