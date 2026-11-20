/**
 * 三评审陪审团（M5）的判决矩阵、证据绑定、降级路径与接线。
 *
 * 分四层测，缺一层都会漏：
 *  1. 纯判决层（lib/jury.js）：每种票型都钉死，含非法输入「不许抛」；
 *  2. 证据绑定层（lib/jury-basis.js）：票必须指认本会话里真实发生的事；
 *  3. 判决层接线（lib/verdict.js）：默认关闭时逐字段不变，requireJury 时只做加法；
 *  4. 门禁接线（lib/gate.js + lib/index.js）：票要绑 diff 摘要、坏票箱不可用、
 *     运维回合不吃票——前两层全绿都说明不了门禁会这么用。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AGGREGATE_VERDICTS,
  JURY_ROLES,
  JURY_SEATS,
  aggregateJuryForGate,
  aggregateVotes,
  isAggregateVerdict,
  needFor,
  normalizeBasis,
  normalizeVote,
} from '../lib/jury.js';
import {
  canaryKilledIds,
  expertCallEvidence,
  fileRefMatches,
  juryBasisContextOf,
  resetJuryBasisWarningsForTests,
  verifyVoteBasis,
} from '../lib/jury-basis.js';
import { decideReview, REASON_TEXT } from '../lib/verdict.js';
import { applyConfig, getConfig, resetConfigForTests } from '../lib/config.js';
import {
  castJuryVote,
  clearJuryVotes,
  juryJournalPathFor,
  readJuryJournal,
  resetJuryStoreForTests,
} from '../lib/jury-store.js';
import { recordReceipt } from '../lib/canary.js';
import { recordWrite } from '../lib/observed.js';
import { apply } from '../lib/index.js';
import { clearGateState, handleTurnStopping, lastDiffOf, statusOf } from '../lib/gate.js';

// 票箱落在 $DSH_HOME 下，测完必须能清掉；用独立临时目录，不碰真实 ~/.dsh。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-jury-test-'));
process.env.DSH_HOME = TMP_HOME;
delete process.env.DSH_REVIEW_GATE_JURY;
delete process.env.DSH_REVIEW_GATE_JURY_REQUIRE;

test.after(() => {
  try {
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
  } catch { /* ignore */ }
});

const vote = (role, verdict, extra = {}) => ({ role, verdict, ...extra });
const fileBasisFor = (role) => ({ kind: 'file', ref: `lib/${role}.js` });
const expertBasisFor = (role) => ({ kind: 'expert', ref: `call-${role}` });
/**
 * 一张「形状合法」的票。P0-1 之后：pass 必须由 expert 支撑，其余 verdict 用 file 证据；
 * 每个角色的 ref 互不相同（三票要指认三个不同的事实）。能不能真的指认到由工具层判。
 */
const boundVote = (role, verdict, extra = {}) => ({
  role,
  verdict,
  basis: verdict === 'pass' ? expertBasisFor(role) : fileBasisFor(role),
  ...extra,
});

// ------------------------------------------------------------ need 计算

test('need = floor(n/2)+1：n=1/2/3/5 → 1/2/2/3', () => {
  assert.equal(needFor(1), 1);
  assert.equal(needFor(2), 2);
  assert.equal(needFor(3), 2, '三席取两票——这是 majority 的核心');
  assert.equal(needFor(5), 3);
});

test('need 对非法 n 有确定行为（0/负数/非数字 → 1，不是 NaN）', () => {
  for (const n of [0, -3, undefined, null, 'x', NaN]) {
    const got = needFor(n);
    assert.equal(got, 1, `needFor(${String(n)}) 必须是有限数`);
    assert.ok(Number.isInteger(got));
  }
});

// ------------------------------------------------------------ 判决矩阵

test('2/3 pass → pass（三席取两票）', () => {
  const r = aggregateVotes([
    vote('fact', 'pass'),
    vote('opposition', 'pass'),
    vote('gap', 'fail', { reason: '缺一条边界用例' }),
  ]);
  assert.equal(r.verdict, 'pass');
  assert.equal(r.need, 2);
  assert.deepEqual(r.counts, { pass: 2, fail: 1, insufficient: 0, undecidable: 0, total: 3 });
});

test('1/3 pass → 不是 pass（没有多数，判 unclear 而不是通过）', () => {
  const r = aggregateVotes([
    vote('fact', 'pass'),
    vote('opposition', 'fail'),
    vote('gap', 'undecidable'),
  ]);
  assert.notEqual(r.verdict, 'pass');
  assert.equal(r.verdict, 'unclear');
  assert.match(r.reason, /没有判决达到门槛/);
});

test('全 fail → fail', () => {
  const r = aggregateVotes([vote('fact', 'fail'), vote('opposition', 'fail'), vote('gap', 'fail')]);
  assert.equal(r.verdict, 'fail');
  assert.equal(r.counts.fail, 3);
});

test('全 undecidable → unclear（不是 fail，也不放行）', () => {
  const r = aggregateVotes([
    vote('fact', 'undecidable'),
    vote('opposition', 'undecidable'),
    vote('gap', 'undecidable'),
  ]);
  assert.equal(r.verdict, 'unclear');
  assert.match(r.reason, /全部判不了/);
});

test('无票（[]）→ unavailable', () => {
  const r = aggregateVotes([]);
  assert.equal(r.verdict, 'unavailable');
  assert.equal(r.counts.total, 0);
  assert.match(r.reason, /没有有效票/);
});

test('topped：2 票 insufficient 且都是 boundary=external', () => {
  const r = aggregateVotes([
    vote('fact', 'insufficient', { boundary: 'external' }),
    vote('opposition', 'insufficient', { boundary: 'external' }),
  ]);
  assert.equal(r.verdict, 'topped');
  assert.equal(r.need, 2, '两票时门槛 2，但 topped 是独立判决，不受多数门槛影响');
  assert.match(r.reason, /超出可评审边界/);
});

test('topped：三票里 2 票 external insufficient（第 3 票 pass）仍然是 topped', () => {
  const r = aggregateVotes([
    vote('fact', 'pass'),
    vote('opposition', 'insufficient', { boundary: 'external' }),
    vote('gap', 'insufficient', { boundary: 'external' }),
  ]);
  assert.equal(r.verdict, 'topped', '没有多数时，边界缺口是比「再补证据」更硬的结论');
});

test('topped 反向：2 票 insufficient 但有一票 boundary=internal → 不是 topped', () => {
  const r = aggregateVotes([
    vote('fact', 'insufficient', { boundary: 'external' }),
    vote('opposition', 'insufficient', { boundary: 'internal' }),
  ]);
  assert.equal(r.verdict, 'unclear');
});

test('topped 反向：只有 1 票 external insufficient → 不是 topped', () => {
  const r = aggregateVotes([
    vote('fact', 'insufficient', { boundary: 'external' }),
    vote('opposition', 'undecidable'),
  ]);
  assert.equal(r.verdict, 'unclear');
});

test('多数 pass 优先于 topped 条件（多数已经明确时边界票不推翻多数）', () => {
  const r = aggregateVotes([
    vote('fact', 'pass'),
    vote('opposition', 'pass'),
    vote('gap', 'insufficient', { boundary: 'external' }),
  ]);
  assert.equal(r.verdict, 'pass');
});

test('n=5 也按同一公式：3/5 pass → pass', () => {
  const r = aggregateVotes([
    vote('fact', 'pass'),
    vote('fact', 'pass'),
    vote('fact', 'pass'),
    vote('fact', 'fail'),
    vote('fact', 'fail'),
  ]);
  assert.equal(r.need, 3);
  assert.equal(r.verdict, 'pass');
});

// ------------------------------------------------------------ 非法输入：必须 unavailable 且不抛

test('非法输入 → unavailable，且绝不抛异常', () => {
  const cases = [
    ['非数组 null', null],
    ['非数组字符串', 'pass'],
    ['非数组对象', { verdict: 'pass' }],
    ['非数组 undefined', undefined],
    ['未知 role', [vote('hacker', 'pass')]],
    ['未知 verdict', [vote('fact', 'maybe')]],
    ['缺 role', [{ verdict: 'pass' }]],
    ['缺 verdict', [{ role: 'fact' }]],
    ['票不是对象', ['pass']],
    ['票是数组', [[]]],
    ['未知 boundary', [vote('fact', 'insufficient', { boundary: 'cosmic' })]],
    ['未知 basis.kind', [vote('fact', 'pass', { basis: { kind: 'vibes', ref: 'x' } })]],
    ['basis.ref 为空', [vote('fact', 'pass', { basis: { kind: 'file', ref: '  ' } })]],
    ['digest 不是字符串', [vote('fact', 'pass', { digest: 42 })]],
  ];
  for (const [label, input] of cases) {
    let result;
    assert.doesNotThrow(() => { result = aggregateVotes(input); }, `${label} 不许抛`);
    assert.equal(result.verdict, 'unavailable', `${label} 必须 unavailable`);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0, `${label} 必须给出原因`);
  }
});

test('坏票不许被多数公式「补掉」：一张坏票让整组 unavailable', () => {
  const r = aggregateVotes([
    vote('fact', 'pass'),
    vote('opposition', 'pass'),
    { role: 'gap', verdict: 'PASS' }, // 大小写不同 = 未知 verdict
  ]);
  assert.equal(r.verdict, 'unavailable', '静默丢掉坏票会把 2/2 算成通过');
});

test('normalizeVote：合法票归一化，reason 非字符串被丢弃但不作废整票', () => {
  assert.deepEqual(normalizeVote({ role: 'fact', verdict: 'pass' }), {
    ok: true,
    vote: { role: 'fact', verdict: 'pass' },
  });
  assert.deepEqual(
    normalizeVote({ role: 'gap', verdict: 'insufficient', boundary: 'internal', reason: '缺用例' }),
    { ok: true, vote: { role: 'gap', verdict: 'insufficient', boundary: 'internal', reason: '缺用例' } },
  );
  const weird = normalizeVote({ role: 'gap', verdict: 'fail', reason: 42 });
  assert.equal(weird.ok, true);
  assert.equal('reason' in weird.vote, false);
});

test('normalizeBasis：只认三种类别 + 非空 ref', () => {
  assert.deepEqual(normalizeBasis({ kind: 'expert', ref: ' c1 ' }), { ok: true, basis: { kind: 'expert', ref: 'c1' } });
  assert.equal(normalizeBasis({ kind: 'file', ref: 'lib/a.js' }).ok, true);
  assert.equal(normalizeBasis({ kind: 'canary', ref: 'verified' }).ok, true);
  for (const bad of [null, 'expert', { kind: 'expert' }, { kind: 'x', ref: 'a' }, { kind: 'file', ref: '   ' }]) {
    assert.equal(normalizeBasis(bad).ok, false, JSON.stringify(bad));
  }
});

// ------------------------------------------------------------ 门禁层的票型成立条件

test('三席齐备才算票型：2 票 pass → unavailable（不能把「第三票还没投」当通过）', () => {
  const r = aggregateJuryForGate([boundVote('fact', 'pass'), boundVote('opposition', 'pass')]);
  assert.equal(r.verdict, 'unavailable');
  assert.match(r.reason, /需要 3 席齐备/);
});

test('三席齐备：2 pass + 1 fail → pass', () => {
  const r = aggregateJuryForGate([
    boundVote('fact', 'pass'),
    boundVote('opposition', 'pass'),
    boundVote('gap', 'fail'),
  ]);
  assert.equal(r.verdict, 'pass');
});

test('三席齐备但不是 pass：fail / topped / unclear 原样透出', () => {
  assert.equal(
    aggregateJuryForGate([boundVote('fact', 'fail'), boundVote('opposition', 'fail'), boundVote('gap', 'fail')]).verdict,
    'fail',
  );
  assert.equal(
    aggregateJuryForGate([
      boundVote('fact', 'insufficient', { boundary: 'external' }),
      boundVote('opposition', 'insufficient', { boundary: 'external' }),
      boundVote('gap', 'undecidable'),
    ]).verdict,
    'topped',
  );
  assert.equal(
    aggregateJuryForGate([
      boundVote('fact', 'undecidable'),
      boundVote('opposition', 'undecidable'),
      boundVote('gap', 'undecidable'),
    ]).verdict,
    'unclear',
  );
});

test('P0：票绑在别的 diff 版本上 → 票型不成立（unavailable），哪怕三票都 pass', () => {
  const r = aggregateJuryForGate([
    boundVote('fact', 'pass', { digest: 'D1' }),
    boundVote('opposition', 'pass', { digest: 'D1' }),
    boundVote('gap', 'pass', { digest: 'D2' }),
  ], { digest: 'D1' });
  assert.equal(r.verdict, 'unavailable');
  assert.match(r.reason, /与当前 diff 摘要不一致/);
});

test('P0：没有 digest 的票，在给了当前 digest 时同样不成立', () => {
  const r = aggregateJuryForGate([
    boundVote('fact', 'pass'),
    boundVote('opposition', 'pass'),
    boundVote('gap', 'pass'),
  ], { digest: 'D1' });
  assert.equal(r.verdict, 'unavailable');
});

test('P0：三票同一 digest → pass（正向对照）', () => {
  const r = aggregateJuryForGate([
    boundVote('fact', 'pass', { digest: 'D1' }),
    boundVote('opposition', 'pass', { digest: 'D1' }),
    boundVote('gap', 'fail', { digest: 'D1' }),
  ], { digest: 'D1' });
  assert.equal(r.verdict, 'pass');
});

// ------------------------------------------------------------ 证据绑定层

test('expertCallEvidence：只认「代码审查工程师」的成功调用', () => {
  const events = [
    {
      type: 'tool/call',
      data: { turn: 1, callId: 'c1', name: 'summon_expert', arguments: JSON.stringify({ expert: '代码审查工程师' }) },
    },
    {
      type: 'tool/result',
      data: { message: { source: { callId: 'c1' }, content: [{ type: 'text', text: '审查完成' }] } },
    },
    {
      type: 'tool/call',
      data: { turn: 1, callId: 'c2', name: 'summon_expert', arguments: JSON.stringify({ expert: 'UI 设计师' }) },
    },
  ];
  const calls = expertCallEvidence(events);
  assert.deepEqual(calls, [{ callId: 'c1', tool: 'summon_expert', ok: true, turn: 1 }], '别的专家不能当评审证据');
});

test('expertCallEvidence：失败结果的调用 ok=false（不能当证据）', () => {
  const events = [
    {
      type: 'tool/call',
      data: { turn: 1, callId: 'c9', name: 'summon_expert', arguments: JSON.stringify({ expert: '代码审查工程师' }) },
    },
    {
      type: 'tool/result',
      data: { message: { source: { callId: 'c9' }, isError: true, content: [{ type: 'text', text: 'boom' }] } },
    },
  ];
  assert.deepEqual(expertCallEvidence(events), [{ callId: 'c9', tool: 'summon_expert', ok: false, turn: 1 }]);
});

test('verifyVoteBasis(expert)：ref 必须指认到一次成功的专家调用', () => {
  const ctx = { expertCalls: [{ callId: 'c1', ok: true }, { callId: 'c2', ok: false }] };
  assert.equal(verifyVoteBasis({ kind: 'expert', ref: 'c1' }, ctx).ok, true);
  assert.equal(verifyVoteBasis({ kind: 'expert', ref: 'c2' }, ctx).ok, false, '失败的调用不能当证据');
  assert.equal(verifyVoteBasis({ kind: 'expert', ref: 'nope' }, ctx).ok, false);
  const empty = verifyVoteBasis({ kind: 'expert', ref: 'c1' }, { expertCalls: [] });
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /先评审，再投票/);
});

test('verifyVoteBasis(canary)：必须是 verified 回执，且 ref 在 killed 列表里', () => {
  const ctx = { canary: { state: 'verified', killed: ['m1'] } };
  assert.equal(verifyVoteBasis({ kind: 'canary', ref: 'm1' }, ctx).ok, true);
  assert.equal(verifyVoteBasis({ kind: 'canary', ref: 'verified' }, ctx).ok, true);
  assert.equal(verifyVoteBasis({ kind: 'canary', ref: 'm2' }, ctx).ok, false);
  const unproven = verifyVoteBasis({ kind: 'canary', ref: 'verified' }, { canary: { state: 'unproven', killed: [] } });
  assert.equal(unproven.ok, false);
});

test('verifyVoteBasis(file)：ref 必须指认到本会话写过的文件（相对/绝对都认）', () => {
  const ctx = { files: ['/repo/lib/a.js', '/repo/tests/b.test.js'] };
  assert.equal(verifyVoteBasis({ kind: 'file', ref: 'lib/a.js' }, ctx).ok, true);
  assert.equal(verifyVoteBasis({ kind: 'file', ref: '/repo/tests/b.test.js' }, ctx).ok, true);
  assert.equal(verifyVoteBasis({ kind: 'file', ref: 'lib/other.js' }, ctx).ok, false);
  assert.equal(verifyVoteBasis({ kind: 'file', ref: 'a.js' }, ctx).ok, false, '不做 basename 模糊匹配');
  assert.equal(verifyVoteBasis({ kind: 'file', ref: 'lib/a.js' }, { files: [] }).ok, false);
});

test('canaryKilledIds：只取被具名断言杀死的变异体', () => {
  const receipt = {
    mutants: [
      { id: 'a', verdict: 'KILLED_BY_ASSERTION' },
      { id: 'b', verdict: 'survived' },
      { id: 'c', killed: true },
    ],
  };
  assert.deepEqual(canaryKilledIds(receipt), ['a', 'c']);
  assert.deepEqual(canaryKilledIds(null), []);
});

test('fileRefMatches：绝不把 a/x.js 与 b/x.js 混为一谈', () => {
  assert.equal(fileRefMatches('/repo/a/x.js', 'a/x.js'), true);
  assert.equal(fileRefMatches('/repo/a/x.js', 'x.js'), false);
  assert.equal(fileRefMatches('/repo/a/x.js', '/repo/a/x.js'), true);
});

test('juryBasisContextOf：可注入三处事实（events / files / canary）', () => {
  const ctx = juryBasisContextOf({
    agent: {},
    sessionId: 'ctx-1',
    deps: {
      events: { events: [], available: true },
      files: () => ['/repo/lib/x.js'],
      canaryState: () => 'verified',
      canaryReceipt: () => ({ mutants: [{ id: 'm1', killed: true }] }),
    },
  });
  assert.deepEqual(ctx.files, ['/repo/lib/x.js']);
  assert.deepEqual(ctx.canary, { state: 'verified', killed: ['m1'] });
});

// ------------------------------------------------------------ 判决层：默认关闭时逐字段不变

test('回归矩阵：不带 jury 的调用，返回值与改动前逐字段一致', () => {
  const matrix = [
    [{}, { reviewed: false, reason: 'no-call' }],
    [{ eventsAvailable: false, callSeen: false }, { reviewed: true, reason: 'undetermined-events' }],
    [{ callSeen: true, resultOk: false }, { reviewed: false, reason: 'call-failed' }],
    [{ callSeen: false, callUnresolved: true }, { reviewed: false, reason: 'call-unresolved' }],
    [{ callSeen: true, resultOk: true, journalVerdict: 'reject' }, { reviewed: false, reason: 'journal-rejected' }],
    [{ callSeen: true, resultOk: true, digestFresh: false }, { reviewed: false, reason: 'stale' }],
    [{ callSeen: true, resultOk: true, requiresLens: true, lensSeen: false }, { reviewed: false, reason: 'no-lens' }],
    [{ callSeen: true, resultOk: true, journalVerdict: 'accept' }, { reviewed: true, reason: 'ok' }],
  ];
  for (const [signals, expected] of matrix) {
    assert.deepEqual(decideReview(signals), expected, `输入 ${JSON.stringify(signals)}`);
  }
});

test('requireJury 不为 true 时，即使传了 jury（含 fail/topped）也逐字段不变', () => {
  const base = { callSeen: true, resultOk: true, journalVerdict: 'accept' };
  const legacy = decideReview(base);
  for (const verdict of ['pass', 'fail', 'topped', 'unclear', 'unavailable', 'nonsense']) {
    const got = decideReview({ ...base, jury: { verdict }, juryRequired: false });
    assert.deepEqual(got, legacy, `requireJury=false 时 ${verdict} 不许改变结论`);
  }
});

test('返回对象永远只有 reviewed / reason 两个字段（签名不许变）', () => {
  const keys = Object.keys(decideReview({
    callSeen: true,
    resultOk: true,
    journalVerdict: 'accept',
    jury: { verdict: 'pass' },
    juryRequired: true,
  }));
  assert.deepEqual(keys, ['reviewed', 'reason']);
});

// ------------------------------------------------------------ 判决层：requireJury=true

test('requireJury：既有判定通过 ∧ jury pass → 通过', () => {
  const r = decideReview({
    callSeen: true,
    resultOk: true,
    journalVerdict: 'accept',
    jury: { verdict: 'pass' },
    juryRequired: true,
  });
  assert.equal(r.reviewed, true);
  assert.equal(r.reason, 'ok');
});

test('requireJury：topped / unclear / unavailable / fail 一律不放行，且原因可区分', () => {
  const base = { callSeen: true, resultOk: true, journalVerdict: 'accept' };
  const expectations = {
    fail: 'jury-fail',
    topped: 'jury-topped',
    unclear: 'jury-unclear',
    unavailable: 'jury-unavailable',
  };
  for (const [verdict, reason] of Object.entries(expectations)) {
    const r = decideReview({ ...base, jury: { verdict }, juryRequired: true });
    assert.equal(r.reviewed, false, `${verdict} 不许放行`);
    assert.equal(r.reason, reason);
    assert.equal(typeof REASON_TEXT[reason], 'string', `${reason} 必须有可读解释`);
  }
});

test('requireJury：缺 jury / 不认识的 jury 值 → jury-unavailable（读不懂不许当通过）', () => {
  const base = { callSeen: true, resultOk: true, journalVerdict: 'accept' };
  for (const jury of [undefined, null, {}, { verdict: 'insufficient' }, { verdict: 'PASS' }, 'pass', 'topped']) {
    const r = decideReview({ ...base, jury, juryRequired: true });
    assert.equal(r.reviewed, false, `jury=${JSON.stringify(jury)} 不许放行`);
    assert.equal(r.reason, 'jury-unavailable');
  }
});

test('requireJury：既有拒绝路径优先（jury pass 也不能翻案）', () => {
  const r = decideReview({ callSeen: false, jury: { verdict: 'pass' }, juryRequired: true });
  assert.deepEqual(r, { reviewed: false, reason: 'no-call' });
  const failed = decideReview({ callSeen: true, resultOk: false, jury: { verdict: 'pass' }, juryRequired: true });
  assert.deepEqual(failed, { reviewed: false, reason: 'call-failed' });
});

test('判决集只有 5 个值，且只有 pass 是放行态', () => {
  assert.deepEqual([...AGGREGATE_VERDICTS], ['pass', 'fail', 'topped', 'unclear', 'unavailable']);
  assert.equal(isAggregateVerdict('pass'), true);
  assert.equal(isAggregateVerdict('PASS'), false);
  assert.equal(isAggregateVerdict(undefined), false);
});

// ------------------------------------------------------------ 配置

test('配置默认：jury.enabled=false、jury.requireJury=false', () => {
  resetConfigForTests();
  applyConfig({});
  const c = getConfig();
  assert.equal(c.jury.enabled, false);
  assert.equal(c.jury.requireJury, false);
});

test('配置：字符串/数组/null 一律按全关处理（读不懂开关就选不启用）', () => {
  resetConfigForTests();
  for (const raw of ['true', 1, [], null, undefined]) {
    applyConfig({ jury: raw });
    const c = getConfig();
    assert.equal(c.jury.enabled, false, `jury=${JSON.stringify(raw)}`);
    assert.equal(c.jury.requireJury, false);
  }
});

test('配置：字符串 "true" 能打开；数字 1 不算开（沿用既有 coerceBool 口径）', () => {
  resetConfigForTests();
  applyConfig({ jury: { enabled: 'true', requireJury: 'true' } });
  const c = getConfig();
  assert.equal(c.jury.enabled, true);
  assert.equal(c.jury.requireJury, true);
  applyConfig({ jury: { enabled: 1, requireJury: 1 } });
  assert.equal(getConfig().jury.enabled, false);
  applyConfig({});
});

test('P1-2：requireJury=true 但 enabled 未开 → 必须 console.warn 一次（不许静默无效）', () => {
  resetConfigForTests();
  const warned = [];
  const original = console.warn;
  console.warn = (...args) => { warned.push(args.join(' ')); };
  try {
    applyConfig({ jury: { requireJury: true } });
    assert.equal(warned.length, 1, '必须告警：用户以为在拦，实际没拦');
    assert.match(warned[0], /requireJury 已被忽略/);
    assert.match(warned[0], /jury\.enabled=true/);
    // 只告警一次：开关每回合都可能重读，重复刷屏等于没有告警。
    applyConfig({ jury: { requireJury: true } });
    assert.equal(warned.length, 1);
    // 正确配置不该告警。
    applyConfig({ jury: { enabled: true, requireJury: true } });
    assert.equal(warned.length, 1);
  } finally {
    console.warn = original;
    resetConfigForTests();
  }
});

// ------------------------------------------------------------ 票箱

test('票箱：缺 digest → 拒收（票不能没有版本）', () => {
  resetJuryStoreForTests();
  const r = castJuryVote('store-nodigest', boundVote('fact', 'pass'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /digest/);
});

test('票箱：缺 basis → 拒收（无证据的票不收）', () => {
  resetJuryStoreForTests();
  const r = castJuryVote('store-nobasis', vote('fact', 'pass'), { digest: 'D1' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /basis/);
});

test('票箱：basis 形状坏掉 → 拒收', () => {
  resetJuryStoreForTests();
  for (const basis of [{ kind: 'x', ref: 'a' }, { kind: 'file' }, 'expert']) {
    const r = castJuryVote('store-badbasis', vote('fact', 'pass', { basis }), { digest: 'D1' });
    assert.equal(r.ok, false, JSON.stringify(basis));
  }
});

test('票箱：三票落盘可读回，digest 由门禁写入；同角色改票是覆盖不是追加', () => {
  resetJuryStoreForTests();
  const sid = 'store-basic';
  assert.deepEqual(readJuryJournal(sid).votes, []);
  assert.equal(castJuryVote(sid, boundVote('fact', 'pass'), { digest: 'D1' }).ok, true);
  assert.equal(castJuryVote(sid, boundVote('opposition', 'insufficient', { boundary: 'external' }), { digest: 'D1' }).ok, true);
  assert.equal(castJuryVote(sid, boundVote('gap', 'fail'), { digest: 'D1' }).ok, true);
  const journal = readJuryJournal(sid);
  assert.equal(journal.invalid, false);
  assert.deepEqual(journal.votes.map((v) => [v.role, v.verdict, v.digest]), [
    ['fact', 'pass', 'D1'],
    ['opposition', 'insufficient', 'D1'],
    ['gap', 'fail', 'D1'],
  ]);
  assert.deepEqual(journal.votes[0].basis, { kind: 'expert', ref: 'call-fact' }, 'pass 票必须由 expert 支撑');
  assert.equal(castJuryVote(sid, boundVote('fact', 'fail'), { digest: 'D1' }).ok, true, '同角色再投 = 改票');
  const after = readJuryJournal(sid).votes;
  assert.equal(after.length, 3);
  assert.equal(after.find((v) => v.role === 'fact').verdict, 'fail');
  assert.ok(fs.existsSync(juryJournalPathFor(sid)), '必须真的落盘（journal）');
  clearJuryVotes(sid);
  resetJuryStoreForTests();
  assert.deepEqual(readJuryJournal(sid).votes, [], 'clear 之后不能从磁盘读回旧票');
});

test('P1-1：票箱里有一张坏票 → 整份 invalid，不许静默丢掉它', () => {
  resetJuryStoreForTests();
  const sid = 'store-invalid-entry';
  fs.mkdirSync(path.dirname(juryJournalPathFor(sid)), { recursive: true });
  fs.writeFileSync(juryJournalPathFor(sid), JSON.stringify({
    version: 1,
    votes: [
      { role: 'fact', verdict: 'pass', digest: 'D1', basis: { kind: 'file', ref: 'a.js' } },
      { role: 'opposition', verdict: 'pass', digest: 'D1', basis: { kind: 'file', ref: 'a.js' } },
      { role: 'gap', verdict: 'PASS', digest: 'D1' }, // 坏票
      { role: 'gap', verdict: 'pass', digest: 'D1', basis: { kind: 'file', ref: 'a.js' } },
    ],
  }), 'utf8');
  resetJuryStoreForTests();
  const journal = readJuryJournal(sid);
  assert.equal(journal.invalid, true, '[pass,pass,坏,pass] 不能读成 3 张好票');
  assert.match(journal.reason, /第 3 票非法/);
  assert.deepEqual(journal.votes, []);
});

test('P1-1：invalid 票箱拒收新票并提示先 reset（不静默覆盖坏证据）', () => {
  resetJuryStoreForTests();
  const sid = 'store-invalid-cast';
  fs.mkdirSync(path.dirname(juryJournalPathFor(sid)), { recursive: true });
  fs.writeFileSync(juryJournalPathFor(sid), '{oops', 'utf8');
  resetJuryStoreForTests();
  const r = castJuryVote(sid, boundVote('fact', 'pass'), { digest: 'D1' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /reset/);
});

test('票箱：坏 journal 文件 → invalid（不是「没投票」）', () => {
  resetJuryStoreForTests();
  const sid = 'store-corrupt';
  fs.mkdirSync(path.dirname(juryJournalPathFor(sid)), { recursive: true });
  fs.writeFileSync(juryJournalPathFor(sid), '{not json', 'utf8');
  resetJuryStoreForTests();
  const journal = readJuryJournal(sid);
  assert.equal(journal.invalid, true);
  assert.match(journal.reason, /不是合法 JSON/);
});

test('票箱：没有会话 id 不归档', () => {
  resetJuryStoreForTests();
  assert.equal(castJuryVote('', boundVote('fact', 'pass'), { digest: 'D1' }).ok, false);
  assert.deepEqual(readJuryJournal('').votes, []);
});

// ------------------------------------------------------------ 门禁接线

function makeAgent({ id = 'jury-s1', depth = 0, events = [], cwd = '/tmp/work' } = {}) {
  const steered = [];
  return {
    id,
    steered,
    session: { header: { cwd, delegationDepth: depth }, snapshotEvents: () => events },
    steer: (message) => steered.push(message),
  };
}

const reviewCallEvent = (turn, callId = 'c1') => ({
  type: 'tool/call',
  data: {
    turn,
    step: 1,
    callId,
    name: 'summon_expert',
    arguments: JSON.stringify({ expert: '代码审查工程师', task: '审查未提交的更改' }),
  },
});
const reviewResultEvent = (turn, callId = 'c1', text = '审查完成：未发现阻塞问题') => ({
  type: 'tool/result',
  data: {
    turn,
    step: 2,
    message: { role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text }] },
  },
});
const expertCall = (callId, turn = 1) => ({
  type: 'tool/call',
  data: { turn, step: 1, callId, name: 'summon_expert', arguments: JSON.stringify({ expert: '代码审查工程师' }) },
});
const expertResult = (callId) => ({
  type: 'tool/result',
  data: { message: { source: { callId }, content: [{ type: 'text', text: '完成' }] } },
});
const bashCall = (turn, command) => ({
  type: 'tool/call',
  data: { turn, step: 1, callId: `bash-${turn}`, name: 'bash', arguments: JSON.stringify({ command }) },
});
const file = (p, added = [], removed = [], status = 'M') => ({ path: p, status, added, removed });
const diffOf = (digest, files = [file('package.json', ['  "x": 1'])]) => ({
  available: true,
  digest,
  files,
  totals: { added: 1, removed: 0 },
});

function resetGate({ enabled = true, requireJury = true } = {}) {
  applyConfig({
    gate: true,
    gateMaxSteersPerTurn: 1,
    gateMaxSteersPerSession: 20,
    jury: { enabled, requireJury },
  });
  clearGateState();
  resetJuryStoreForTests();
}

/** 跑一次门禁（会顺带把 diff 摘要记进 lastDiff，jury_vote 只认这份）。 */
async function runGate(sid, { turn = 1, digest = 'D1', events = [], files } = {}) {
  const agent = makeAgent({ id: sid, events });
  const text = await handleTurnStopping({ agent, turn }, {
    collectDiff: async () => diffOf(digest, files),
    readJournal: async () => ({ verdict: 'unknown' }),
  });
  return { text, agent };
}

test('接线：requireJury=true 且无票 → 本来会放行的回合被拦下（jury-unavailable）', async () => {
  resetGate();
  const { text, agent } = await runGate('jury-novotes', {
    events: [reviewCallEvent(1), reviewResultEvent(1)],
  });
  assert.ok(text, '没有陪审团票型时不能算已评审');
  assert.equal(agent.steered.length, 1);
  const last = statusOf('jury-novotes').last;
  assert.equal(last.reviewed, false);
  assert.equal(last.reason, 'jury-unavailable');
  assert.equal(last.jury.verdict, 'unavailable');
  assert.equal(last.jury.cast, 0);
  assert.match(text, /陪审团/);
});

test('接线（真实路径）：先评审 → 让门禁记下摘要 → 三票 2 pass 1 fail → 放行并消费票', async () => {
  resetGate();
  const sid = 'jury-pass';
  // 第 1 回合：门禁取证，记下 D1（同时也是「还没投票」的拒绝态）
  await runGate(sid, { turn: 1, digest: 'D1' });
  assert.equal(lastDiffOf(sid)?.digest, 'D1', '门禁必须把摘要记下来，票才有版本可绑');
  castJuryVote(sid, boundVote('fact', 'pass'), { digest: 'D1' });
  castJuryVote(sid, boundVote('opposition', 'pass'), { digest: 'D1' });
  castJuryVote(sid, boundVote('gap', 'fail'), { digest: 'D1' });

  const { text, agent } = await runGate(sid, {
    turn: 2,
    digest: 'D1',
    events: [reviewCallEvent(2), reviewResultEvent(2)],
  });
  assert.equal(text, undefined, '既有评审通过 ∧ jury pass → 不该再拦');
  assert.equal(agent.steered.length, 0);
  const last = statusOf(sid).last;
  assert.equal(last.reviewed, true);
  assert.equal(last.reason, 'ok');
  assert.equal(last.jury.verdict, 'pass');
  assert.equal(last.jury.cast, 3);
  assert.deepEqual(readJuryJournal(sid).votes, [], '判决已消费票型：下一版 diff 必须重新取证');
});

test('接线（P0）：票绑在旧 diff 上 → 同一批三票 pass 也不放行', async () => {
  resetGate();
  const sid = 'jury-stale-digest';
  await runGate(sid, { turn: 1, digest: 'D1' });
  castJuryVote(sid, boundVote('fact', 'pass'), { digest: 'D1' });
  castJuryVote(sid, boundVote('opposition', 'pass'), { digest: 'D1' });
  castJuryVote(sid, boundVote('gap', 'pass'), { digest: 'D1' });

  // 代码改了 → 新摘要 D2：旧票不能算数
  const { text } = await runGate(sid, {
    turn: 2,
    digest: 'D2',
    events: [reviewCallEvent(2), reviewResultEvent(2)],
  });
  assert.ok(text, '换了版本就必须重新取证');
  const last = statusOf(sid).last;
  assert.equal(last.reviewed, false);
  assert.equal(last.reason, 'jury-unavailable');
  assert.match(last.jury.reason, /与当前 diff 摘要不一致/);
});

test('接线：topped（2 external insufficient）→ 拦下，理由与其它拒绝态区分', async () => {
  resetGate();
  const sid = 'jury-topped';
  await runGate(sid, { turn: 1, digest: 'D1' });
  castJuryVote(sid, boundVote('fact', 'insufficient', { boundary: 'external' }), { digest: 'D1' });
  castJuryVote(sid, boundVote('opposition', 'insufficient', { boundary: 'external' }), { digest: 'D1' });
  castJuryVote(sid, boundVote('gap', 'undecidable'), { digest: 'D1' });

  const { text } = await runGate(sid, {
    turn: 2,
    digest: 'D1',
    events: [reviewCallEvent(2), reviewResultEvent(2)],
  });
  assert.ok(text);
  const last = statusOf(sid).last;
  assert.equal(last.reviewed, false);
  assert.equal(last.reason, 'jury-topped');
  assert.equal(last.jury.verdict, 'topped');
  assert.match(text, /超出可评审边界|陪审团/);
});

test('接线（P1-1）：票箱里有一张坏票 → 门禁判 unavailable，不拿剩下的票算多数', async () => {
  resetGate();
  const sid = 'jury-invalid-journal';
  await runGate(sid, { turn: 1, digest: 'D1' });
  // 三张好票 + 一张坏票：若静默丢掉坏票会读成 3/3 pass
  fs.mkdirSync(path.dirname(juryJournalPathFor(sid)), { recursive: true });
  fs.writeFileSync(juryJournalPathFor(sid), JSON.stringify({
    version: 1,
    votes: [
      { role: 'fact', verdict: 'pass', digest: 'D1', basis: { kind: 'file', ref: 'a.js' } },
      { role: 'opposition', verdict: 'pass', digest: 'D1', basis: { kind: 'file', ref: 'a.js' } },
      { role: 'gap', verdict: 'maybe', digest: 'D1', basis: { kind: 'file', ref: 'a.js' } },
      { role: 'gap', verdict: 'pass', digest: 'D1', basis: { kind: 'file', ref: 'a.js' } },
    ],
  }), 'utf8');
  resetJuryStoreForTests();

  const { text } = await runGate(sid, {
    turn: 2,
    digest: 'D1',
    events: [reviewCallEvent(2), reviewResultEvent(2)],
  });
  assert.ok(text, '坏票箱不许放行');
  const last = statusOf(sid).last;
  assert.equal(last.reviewed, false);
  assert.equal(last.reason, 'jury-unavailable');
  assert.equal(last.jury.verdict, 'unavailable');
  assert.match(String(last.jury.invalid), /第 3 票非法/);
});

test('接线：enabled=true 但 requireJury=false → 只记录票型，不改变放行结论', async () => {
  resetGate({ enabled: true, requireJury: false });
  const sid = 'jury-advisory';
  await runGate(sid, { turn: 1, digest: 'D1' });
  castJuryVote(sid, boundVote('fact', 'fail'), { digest: 'D1' });
  castJuryVote(sid, boundVote('opposition', 'fail'), { digest: 'D1' });
  castJuryVote(sid, boundVote('gap', 'fail'), { digest: 'D1' });

  const { text } = await runGate(sid, {
    turn: 2,
    digest: 'D1',
    events: [reviewCallEvent(2), reviewResultEvent(2)],
  });
  assert.equal(text, undefined, 'requireJury=false 时陪审团不参与放行');
  const last = statusOf(sid).last;
  assert.equal(last.reviewed, true);
  assert.equal(last.jury.verdict, 'fail', '票型仍然可见（可观测性）');
  assert.equal(readJuryJournal(sid).votes.length, 3, '非 required 时不该消费票');
});

test('接线：jury.enabled=false（默认）→ 完全不读票箱，行为与改动前一致', async () => {
  resetGate({ enabled: false, requireJury: true });
  const sid = 'jury-disabled';
  castJuryVote(sid, boundVote('fact', 'fail'), { digest: 'D1' });
  castJuryVote(sid, boundVote('opposition', 'fail'), { digest: 'D1' });
  castJuryVote(sid, boundVote('gap', 'fail'), { digest: 'D1' });

  const { text } = await runGate(sid, {
    turn: 1,
    digest: 'D1',
    events: [reviewCallEvent(1), reviewResultEvent(1)],
  });
  assert.equal(text, undefined, '默认关闭时必须与旧行为逐字段一致');
  const last = statusOf(sid).last;
  assert.equal(last.reviewed, true);
  assert.equal('jury' in last, false, '关闭时连状态字段都不该出现');
  assert.equal(readJuryJournal(sid).votes.length, 3, '关闭时不消费票箱');
});

test('接线（P2）：运维回合不吃票（消费只在确实用它放行之后）', async () => {
  resetGate();
  const sid = 'jury-ops-turn';
  await runGate(sid, { turn: 1, digest: 'D1' });
  castJuryVote(sid, boundVote('fact', 'pass'), { digest: 'D1' });
  castJuryVote(sid, boundVote('opposition', 'pass'), { digest: 'D1' });
  castJuryVote(sid, boundVote('gap', 'pass'), { digest: 'D1' });

  // 只做了 git commit → 运维回合，不评审、也不该消费陪审团票
  const { text } = await runGate(sid, {
    turn: 2,
    digest: 'D1',
    events: [bashCall(2, 'git commit -m "x"')],
  });
  assert.equal(text, undefined);
  assert.equal(statusOf(sid).last.skipped, 'ops-only');
  assert.equal(readJuryJournal(sid).votes.length, 3, '运维回合吃掉刚投的票 = 白投一轮');
});

test('接线：陪审团拦下时，reviewScope 语义不被绕过（窄范围照常算出并给出）', async () => {
  resetGate();
  const sid = 'jury-scope';
  const unchanged = file('src/a.js', ['// 没动过']);
  const firstFiles = [file('package.json', ['  "x": 1']), unchanged];
  const secondFiles = [file('package.json', ['  "x": 2']), unchanged];

  // 第 1 回合：门禁记下 D1（陪审团还没票 → 拒绝态）
  await runGate(sid, { turn: 1, digest: 'D1', files: firstFiles });
  castJuryVote(sid, boundVote('fact', 'pass'), { digest: 'D1' });
  castJuryVote(sid, boundVote('opposition', 'pass'), { digest: 'D1' });
  castJuryVote(sid, boundVote('gap', 'pass'), { digest: 'D1' });
  // 第 2 回合：jury pass → 记为已评审并写入基线
  const t2 = await runGate(sid, { turn: 2, digest: 'D1', files: firstFiles, events: [reviewCallEvent(2), reviewResultEvent(2)] });
  assert.equal(t2.text, undefined);
  assert.equal(statusOf(sid).reviewScope, null, '首次评审没有基线，不该凭空给窄范围');

  // 第 3 回合：只改 package.json，先让门禁记下 D2
  await runGate(sid, { turn: 3, digest: 'D2', files: secondFiles });
  castJuryVote(sid, boundVote('fact', 'insufficient', { boundary: 'external' }), { digest: 'D2' });
  castJuryVote(sid, boundVote('opposition', 'insufficient', { boundary: 'external' }), { digest: 'D2' });
  castJuryVote(sid, boundVote('gap', 'undecidable'), { digest: 'D2' });
  // 第 4 回合：jury topped → 拦下，但窄范围必须照常算出
  const t4 = await runGate(sid, { turn: 4, digest: 'D2', files: secondFiles, events: [reviewCallEvent(4), reviewResultEvent(4)] });
  assert.ok(t4.text, '陪审团 topped 必须拦下');
  const status = statusOf(sid);
  assert.equal(status.last.reason, 'jury-topped');
  assert.deepEqual(status.reviewScope, { mode: 'narrow', files: ['package.json'], reason: 'changed' },
    '陪审团只加否决权，不许绕过 review-scope 的窄范围语义');
  assert.match(status.last.hint, /不要全量重审/);
});

// ------------------------------------------------------------ 工具：注册与证据绑定

function makeCtx() {
  const registeredTools = [];
  const ctx = {
    on() { return () => {}; },
    effect(fn) {
      const disposer = fn();
      return () => (typeof disposer === 'function' ? disposer() : undefined);
    },
    tools: {
      register(tool) {
        registeredTools.push(tool);
        return () => {};
      },
    },
    logger: { info() {}, warn() {} },
  };
  return { ctx, registeredTools };
}

test('工具：默认关闭时不注册 jury_vote / jury_status', () => {
  applyConfig({ gate: true });
  const { ctx, registeredTools } = makeCtx();
  apply(ctx, { gate: true });
  const names = registeredTools.map((tool) => tool.name);
  assert.equal(names.includes('jury_vote'), false);
  assert.equal(names.includes('jury_status'), false);
  assert.ok(names.includes('review_gate_status'), '既有工具不受影响');
});

test('工具：enabled=true 时注册，vote / status / reset 走通（三条不同的 expert 证据 + 门禁摘要）', async () => {
  applyConfig({ gate: true, jury: { enabled: true, requireJury: true } });
  const { ctx, registeredTools } = makeCtx();
  apply(ctx, { gate: true, jury: { enabled: true, requireJury: true } });
  const voteTool = registeredTools.find((tool) => tool.name === 'jury_vote');
  const statusTool = registeredTools.find((tool) => tool.name === 'jury_status');
  const sid = 'tool-session';
  const events = [
    expertCall('call-1', 1), expertResult('call-1'),
    expertCall('call-2', 1), expertResult('call-2'),
    expertCall('call-3', 1), expertResult('call-3'),
  ];
  const exec = { agent: { id: sid, session: { snapshotEvents: () => events } } };

  // 让门禁记下当前 diff 摘要（票必须绑在它上面）
  await runGate(sid, { turn: 1, digest: 'D1' });
  recordWrite(sid, '/repo/lib/x.js', { created: false });

  const cast = await voteTool.execute(
    { role: 'fact', verdict: 'pass', basisKind: 'expert', basisRef: 'call-1', reason: '主流程正确' },
    exec,
  );
  assert.equal(cast.votes.length, 1);
  assert.equal(cast.votes[0].digest, 'D1', '票必须绑在门禁给出的摘要上');
  assert.deepEqual(cast.votes[0].basis, { kind: 'expert', ref: 'call-1' });
  assert.equal(cast.aggregate.verdict, 'unavailable', '一票不足以构成票型');
  assert.equal(cast.needMore, 2);

  await voteTool.execute({ role: 'opposition', verdict: 'pass', basisKind: 'expert', basisRef: 'call-2' }, exec);
  // 缺口派可以用 file 证据投 insufficient：只说明「这处我没看/确实缺」，不参与放行
  await voteTool.execute({ role: 'gap', verdict: 'insufficient', basisKind: 'file', basisRef: 'lib/x.js' }, exec);
  const status = await statusTool.execute({}, exec);
  assert.equal(status.votes.length, 3);
  assert.equal(status.aggregate.verdict, 'pass');
  assert.equal(status.digest, 'D1');

  const reset = await voteTool.execute({ action: 'reset' }, exec);
  assert.equal(reset.reset, true);
  assert.equal(reset.votes.length, 0);
});

test('工具（P0）：无 basis → 拒收；basis 指认不到 → 拒收', async () => {
  applyConfig({ gate: true, jury: { enabled: true, requireJury: true } });
  const { ctx, registeredTools } = makeCtx();
  apply(ctx, { gate: true, jury: { enabled: true, requireJury: true } });
  const voteTool = registeredTools.find((tool) => tool.name === 'jury_vote');
  const sid = 'tool-basis-reject';
  const exec = { agent: { id: sid, session: { snapshotEvents: () => [] } } };
  await runGate(sid, { turn: 1, digest: 'D1' });
  recordWrite(sid, '/repo/lib/real.js', { created: false });

  await assert.rejects(
    () => voteTool.execute({ role: 'fact', verdict: 'pass' }, exec),
    /basis/,
    '无证据的票必须拒收（连点三次不能等于三评审）',
  );
  await assert.rejects(
    () => voteTool.execute({ role: 'fact', verdict: 'pass', basisKind: 'file', basisRef: 'lib/ghost.js' }, exec),
    /不是本会话写过的文件/,
  );
  await assert.rejects(
    () => voteTool.execute({ role: 'fact', verdict: 'pass', basisKind: 'expert', basisRef: 'c-nope' }, exec),
    /找不到对应的专家调用|先评审/,
  );
  await assert.rejects(
    () => voteTool.execute({ role: 'fact', verdict: 'pass', basisKind: 'vibes', basisRef: 'x' }, exec),
    /basis\.kind/,
  );
  assert.equal(readJuryJournal(sid).votes.length, 0, '被拒的票不能留痕');
});

test('工具（P0）：expert 类证据必须指认到本会话一次成功的专家调用', async () => {
  applyConfig({ gate: true, jury: { enabled: true, requireJury: true } });
  const { ctx, registeredTools } = makeCtx();
  apply(ctx, { gate: true, jury: { enabled: true, requireJury: true } });
  const voteTool = registeredTools.find((tool) => tool.name === 'jury_vote');
  const sid = 'tool-expert-basis';
  const events = [
    { type: 'tool/call', data: { turn: 1, callId: 'call-1', name: 'summon_expert', arguments: JSON.stringify({ expert: '代码审查工程师' }) } },
    { type: 'tool/result', data: { message: { source: { callId: 'call-1' }, content: [{ type: 'text', text: '完成' }] } } },
  ];
  const exec = { agent: { id: sid, session: { snapshotEvents: () => events } } };
  await runGate(sid, { turn: 1, digest: 'D1' });

  const cast = await voteTool.execute({ role: 'fact', verdict: 'pass', basisKind: 'expert', basisRef: 'call-1' }, exec);
  assert.equal(cast.votes.length, 1);
  assert.deepEqual(cast.votes[0].basis, { kind: 'expert', ref: 'call-1' });
});

test('工具（P0）：canary 类证据必须指认到 verified 回执里的被杀变异体', async () => {
  resetGate();
  const sid = 'tool-canary-basis';
  await runGate(sid, { turn: 1, digest: 'D1' });
  recordReceipt(sid, { status: 'ok', killed: true, mutants: [{ id: 'mut-1', killed: true }] });
  const { ctx, registeredTools } = makeCtx();
  apply(ctx, { gate: true, jury: { enabled: true, requireJury: true } });
  const voteTool = registeredTools.find((tool) => tool.name === 'jury_vote');
  const exec = { agent: { id: sid, session: { snapshotEvents: () => [] } } };

  // canary 只能支撑非 pass 的结论（跑过 canary ≠ 同意放行）
  const ok = await voteTool.execute({ role: 'fact', verdict: 'insufficient', basisKind: 'canary', basisRef: 'mut-1' }, exec);
  assert.equal(ok.votes.length, 1);
  await assert.rejects(
    () => voteTool.execute({ role: 'opposition', verdict: 'insufficient', basisKind: 'canary', basisRef: 'mut-2' }, exec),
    /不在回执的 killed 变异体列表里/,
  );
  await assert.rejects(
    () => voteTool.execute({ role: 'gap', verdict: 'pass', basisKind: 'canary', basisRef: 'verified' }, exec),
    /pass 票只接受 basis\.kind='expert'/,
  );
});

test('工具：票按 agent.id 归档（与门禁 sessionIdOf 同源，避免「要求陪审团却永远 unavailable」）', async () => {
  applyConfig({ gate: true, jury: { enabled: true, requireJury: true } });
  const { ctx, registeredTools } = makeCtx();
  apply(ctx, { gate: true, jury: { enabled: true, requireJury: true } });
  const voteTool = registeredTools.find((tool) => tool.name === 'jury_vote');
  const sid = 'agent-A';
  await runGate(sid, { turn: 1, digest: 'D1' });
  recordWrite(sid, '/repo/lib/x.js', { created: false });
  // 宿主上 session.id 与 agent.id 可以不同；门禁读的是 agent.id。
  const exec = { agent: { id: sid, session: { id: 'session-B', snapshotEvents: () => [] } } };
  await voteTool.execute({ role: 'fact', verdict: 'insufficient', basisKind: 'file', basisRef: 'lib/x.js' }, exec);
  assert.equal(readJuryJournal('agent-A').votes.length, 1, '票必须落在门禁读的那个键上');
  assert.deepEqual(readJuryJournal('session-B').votes, [], '不许投进一个门禁永远读不到的桶');
});

// ------------------------------------------------------------ P0-1 复审：三条零成本路径必须被封

test('P0-1：pass 只接受 expert——三票同指一个刚写过的文件 → unavailable', () => {
  const sameFilePass = (role) => ({
    role,
    verdict: 'pass',
    basis: { kind: 'file', ref: 'lib/x.js' },
    digest: 'D1',
  });
  const r = aggregateJuryForGate(
    [sameFilePass('fact'), sameFilePass('opposition'), sameFilePass('gap')],
    { digest: 'D1' },
  );
  assert.equal(r.verdict, 'unavailable');
  assert.match(r.reason, /pass 票只接受 basis\.kind='expert'/);
});

test('P0-1：canary 与 file 仍可支撑 insufficient / fail（不是一律拒收）', () => {
  const r = aggregateJuryForGate([
    { role: 'fact', verdict: 'insufficient', basis: { kind: 'canary', ref: 'verified' }, digest: 'D1' },
    { role: 'opposition', verdict: 'insufficient', basis: { kind: 'file', ref: 'lib/a.js' }, digest: 'D1' },
    { role: 'gap', verdict: 'undecidable', basis: { kind: 'file', ref: 'lib/b.js' }, digest: 'D1' },
  ], { digest: 'D1' });
  assert.notEqual(r.verdict, 'unavailable', r.reason);
});

test('P0-1：三票 expert 指认同一个 callId → unavailable（不构成三个视角）', () => {
  const sameCall = (role) => ({
    role,
    verdict: 'pass',
    basis: { kind: 'expert', ref: 'call-1' },
    digest: 'D1',
  });
  const r = aggregateJuryForGate(
    [sameCall('fact'), sameCall('opposition'), sameCall('gap')],
    { digest: 'D1' },
  );
  assert.equal(r.verdict, 'unavailable');
  assert.match(r.reason, /三票指认同一个事实/);
});

test('P0-1：file 证据的绝对/相对写法视为同一事实（不许换个写法绕过去重）', () => {
  const r = aggregateJuryForGate([
    { role: 'fact', verdict: 'insufficient', basis: { kind: 'file', ref: 'lib/x.js' }, digest: 'D1' },
    { role: 'opposition', verdict: 'insufficient', basis: { kind: 'file', ref: '/repo/lib/x.js' }, digest: 'D1' },
    { role: 'gap', verdict: 'undecidable', basis: { kind: 'file', ref: './lib/x.js' }, digest: 'D1' },
  ], { digest: 'D1' });
  assert.equal(r.verdict, 'unavailable');
  assert.match(r.reason, /三票指认同一个事实/);
});

test('P0-1：三个不同 ref 的 pass（三条不同的 expert 调用）→ pass（正向对照）', () => {
  const r = aggregateJuryForGate([
    { role: 'fact', verdict: 'pass', basis: { kind: 'expert', ref: 'call-1' }, digest: 'D1' },
    { role: 'opposition', verdict: 'pass', basis: { kind: 'expert', ref: 'call-2' }, digest: 'D1' },
    { role: 'gap', verdict: 'pass', basis: { kind: 'expert', ref: 'call-3' }, digest: 'D1' },
  ], { digest: 'D1' });
  assert.equal(r.verdict, 'pass');
});

test('P0-1：入箱即拒 pass+file / pass+canary（不等到聚合）', () => {
  resetJuryStoreForTests();
  const sid = 'store-pass-basis';
  for (const basis of [{ kind: 'file', ref: 'lib/x.js' }, { kind: 'canary', ref: 'verified' }]) {
    const r = castJuryVote(sid, { role: 'fact', verdict: 'pass', basis }, { digest: 'D1' });
    assert.equal(r.ok, false, JSON.stringify(basis));
    assert.match(r.reason, /pass 票只接受 basis\.kind='expert'/);
  }
  assert.deepEqual(readJuryJournal(sid).votes, []);
});

test('P0-1：两个角色不能指认同一个事实；同角色改票不受影响', () => {
  resetJuryStoreForTests();
  const sid = 'store-dup-ref';
  const expert = { kind: 'expert', ref: 'call-1' };
  assert.equal(castJuryVote(sid, { role: 'fact', verdict: 'pass', basis: expert }, { digest: 'D1' }).ok, true);
  const clash = castJuryVote(sid, { role: 'opposition', verdict: 'pass', basis: expert }, { digest: 'D1' });
  assert.equal(clash.ok, false);
  assert.match(clash.reason, /三票必须指认三个不同的事实/);
  // 同角色改票沿用同一个 ref 是合法的（它替换的是自己那一票）
  assert.equal(castJuryVote(sid, { role: 'fact', verdict: 'pass', basis: expert }, { digest: 'D1' }).ok, true);
});

test('P1-2：expert 证据必须与当前 diff 同期（上一版 diff 的旧调用不能用）', () => {
  const ctx = {
    expertCalls: [
      { callId: 'c-old', ok: true, turn: 1 },
      { callId: 'c-now', ok: true, turn: 3 },
    ],
    minTurn: 2,
  };
  const old = verifyVoteBasis({ kind: 'expert', ref: 'c-old' }, ctx);
  assert.equal(old.ok, false);
  assert.match(old.reason, /更早的回合/);
  assert.equal(verifyVoteBasis({ kind: 'expert', ref: 'c-now' }, ctx).ok, true, '本回合或之后的调用才作数');
  // 宿主不记 turn 时不能把整条 jury 拦死：fail-open（另有 warn 一次的专用用例）
  resetJuryBasisWarningsForTests();
  const original = console.warn;
  console.warn = () => {};
  try {
    const noTurn = verifyVoteBasis(
      { kind: 'expert', ref: 'c-x' },
      { expertCalls: [{ callId: 'c-x', ok: true }], minTurn: 2 },
    );
    assert.equal(noTurn.ok, true, '没法比同期时 fail-open：拦死比漏一次同期判据更糟');
  } finally {
    console.warn = original;
  }
});

test('接线（P0-1 纵深）：手改票箱塞三票同指一个文件的 pass → 门禁仍判 unavailable', async () => {
  resetGate();
  const sid = 'jury-forged-same-file';
  await runGate(sid, { turn: 1, digest: 'D1' });
  // 绕过 jury_vote（模拟手改本地 JSON / 旧版本产物）：三票 pass 都指同一个文件
  fs.mkdirSync(path.dirname(juryJournalPathFor(sid)), { recursive: true });
  fs.writeFileSync(juryJournalPathFor(sid), JSON.stringify({
    version: 1,
    votes: ['fact', 'opposition', 'gap'].map((role) => ({
      role,
      verdict: 'pass',
      digest: 'D1',
      basis: { kind: 'file', ref: 'lib/x.js' },
    })),
  }), 'utf8');
  resetJuryStoreForTests();

  const { text } = await runGate(sid, {
    turn: 2,
    digest: 'D1',
    events: [reviewCallEvent(2), reviewResultEvent(2)],
  });
  assert.ok(text, '三票同指一个事实不能放行');
  const last = statusOf(sid).last;
  assert.equal(last.reviewed, false);
  assert.equal(last.reason, 'jury-unavailable');
  assert.match(last.jury.reason, /pass 票只接受 basis\.kind='expert'/);
});

test('工具（P0-1）：三条零成本路径全部被拒（同文件 / 同 callId / canary verified）', async () => {
  applyConfig({ gate: true, jury: { enabled: true, requireJury: true } });
  const { ctx, registeredTools } = makeCtx();
  apply(ctx, { gate: true, jury: { enabled: true, requireJury: true } });
  const voteTool = registeredTools.find((tool) => tool.name === 'jury_vote');
  const sid = 'tool-zero-cost';
  const events = [expertCall('call-1', 1), expertResult('call-1')];
  const exec = { agent: { id: sid, session: { snapshotEvents: () => events } } };
  await runGate(sid, { turn: 1, digest: 'D1' });
  recordWrite(sid, '/repo/lib/x.js', { created: false });
  recordReceipt(sid, { status: 'ok', killed: true, mutants: [{ id: 'mut-1', killed: true }] });

  // 路径①：同指一个刚写过的文件
  await assert.rejects(
    () => voteTool.execute({ role: 'fact', verdict: 'pass', basisKind: 'file', basisRef: 'lib/x.js' }, exec),
    /pass 票只接受 basis\.kind='expert'/,
  );
  // 路径②：三票同指同一个 callId（第一个合法，第二、三个被去重拒绝）
  await voteTool.execute({ role: 'fact', verdict: 'pass', basisKind: 'expert', basisRef: 'call-1' }, exec);
  await assert.rejects(
    () => voteTool.execute({ role: 'opposition', verdict: 'pass', basisKind: 'expert', basisRef: 'call-1' }, exec),
    /三票必须指认三个不同的事实/,
  );
  // 路径③：canary 'verified' 想直接投 pass
  await assert.rejects(
    () => voteTool.execute({ role: 'gap', verdict: 'pass', basisKind: 'canary', basisRef: 'verified' }, exec),
    /pass 票只接受 basis\.kind='expert'/,
  );
});

test('工具（P1-2）：上一版 diff 的专家调用不能给这一版投票', async () => {
  applyConfig({ gate: true, jury: { enabled: true, requireJury: true } });
  const { ctx, registeredTools } = makeCtx();
  apply(ctx, { gate: true, jury: { enabled: true, requireJury: true } });
  const voteTool = registeredTools.find((tool) => tool.name === 'jury_vote');
  const sid = 'tool-stale-call';
  const events = [expertCall('call-old', 1), expertResult('call-old')];
  const exec = { agent: { id: sid, session: { snapshotEvents: () => events } } };
  // 门禁在第 2 回合采到 diff 摘要 → minTurn=2，第 1 回合的调用属于上一版
  await runGate(sid, { turn: 2, digest: 'D2' });
  await assert.rejects(
    () => voteTool.execute({ role: 'fact', verdict: 'pass', basisKind: 'expert', basisRef: 'call-old' }, exec),
    /更早的回合/,
  );
});

// ------------------------------------------------------------ 第三轮复审 P2 修复

test('P2-1（修复）：同一 digest 的两轮取证不推进 minTurn，上一轮投的票仍收', async () => {
  resetGate();
  const sid = 'jury-same-digest-turn';
  await runGate(sid, { turn: 1, digest: 'D1' });
  const first = lastDiffOf(sid);
  assert.equal(first.turn, 1);
  // 同一版 diff 在 turn 2 再取证一次：minTurn 必须沿用首次回合
  await runGate(sid, { turn: 2, digest: 'D1' });
  const again = lastDiffOf(sid);
  assert.equal(again.turn, 1, 'minTurn 是「这版 diff 从哪回合存在」，不是「最后一次看它的回合」');
  assert.equal(again.at, first.at, '同一 digest 的 at 也不该推进');
  assert.equal(again.lastSeenTurn, 2, '最后一次看到它的回合单独记，供排障');

  // turn 1 的专家调用对同一版 diff 仍然有效
  const events = [expertCall('c-1', 1), expertResult('c-1')];
  const ctx = { expertCalls: expertCallEvidence(events), minTurn: again.turn, minAt: again.at };
  assert.equal(verifyVoteBasis({ kind: 'expert', ref: 'c-1' }, ctx).ok, true);

  // digest 变了才推进：D2 从 turn 3 起算，旧调用随即失效
  await runGate(sid, { turn: 3, digest: 'D2' });
  assert.equal(lastDiffOf(sid).turn, 3);
  const staleCtx = { expertCalls: expertCallEvidence(events), minTurn: lastDiffOf(sid).turn };
  assert.equal(verifyVoteBasis({ kind: 'expert', ref: 'c-1' }, staleCtx).ok, false);
});

test('P2-2（修复）：宿主不记 turn 时三条不同 expert 票仍能组成 pass，且只 warn 一次', async () => {
  resetJuryBasisWarningsForTests();
  const warned = [];
  const original = console.warn;
  console.warn = (...args) => { warned.push(args.join(' ')); };
  try {
    applyConfig({ gate: true, jury: { enabled: true, requireJury: true } });
    const { ctx, registeredTools } = makeCtx();
    apply(ctx, { gate: true, jury: { enabled: true, requireJury: true } });
    const voteTool = registeredTools.find((tool) => tool.name === 'jury_vote');
    const sid = 'tool-no-turn';
    // 事件里完全没有 turn（模拟不记 turn 的宿主）
    const noTurnCall = (callId) => ({
      type: 'tool/call',
      data: { step: 1, callId, name: 'summon_expert', arguments: JSON.stringify({ expert: '代码审查工程师' }) },
    });
    const events = [
      noTurnCall('c-a'), expertResult('c-a'),
      noTurnCall('c-b'), expertResult('c-b'),
      noTurnCall('c-c'), expertResult('c-c'),
    ];
    const exec = { agent: { id: sid, session: { snapshotEvents: () => events } } };
    await runGate(sid, { turn: 1, digest: 'D1' });

    await voteTool.execute({ role: 'fact', verdict: 'pass', basisKind: 'expert', basisRef: 'c-a' }, exec);
    await voteTool.execute({ role: 'opposition', verdict: 'pass', basisKind: 'expert', basisRef: 'c-b' }, exec);
    const status = await voteTool.execute({ role: 'gap', verdict: 'pass', basisKind: 'expert', basisRef: 'c-c' }, exec);
    assert.equal(status.votes.length, 3, '不能因为宿主不记 turn 就把 requireJury 拦死');
    assert.equal(status.aggregate.verdict, 'pass');
    assert.equal(warned.length, 1, 'fail-open 只告警一次');
    assert.match(warned[0], /fail-open/);
  } finally {
    console.warn = original;
    resetJuryBasisWarningsForTests();
  }
});

test('P2-3（修复）：lib/../lib/x.js 与 lib/x.js 判同一事实（不许用 .. 绕过去重）', () => {
  const r = aggregateJuryForGate([
    { role: 'fact', verdict: 'insufficient', basis: { kind: 'file', ref: 'lib/../lib/x.js' }, digest: 'D1' },
    { role: 'opposition', verdict: 'insufficient', basis: { kind: 'file', ref: 'lib/x.js' }, digest: 'D1' },
    { role: 'gap', verdict: 'undecidable', basis: { kind: 'file', ref: 'lib/other.js' }, digest: 'D1' },
  ], { digest: 'D1' });
  assert.equal(r.verdict, 'unavailable');
  assert.match(r.reason, /三票指认同一个事实/);
  // 对照：三条确实不同的事实 → 不是 unavailable
  const ok = aggregateJuryForGate([
    { role: 'fact', verdict: 'insufficient', basis: { kind: 'file', ref: 'lib/a.js' }, digest: 'D1' },
    { role: 'opposition', verdict: 'insufficient', basis: { kind: 'file', ref: 'lib/b.js' }, digest: 'D1' },
    { role: 'gap', verdict: 'undecidable', basis: { kind: 'file', ref: 'lib/c.js' }, digest: 'D1' },
  ], { digest: 'D1' });
  assert.notEqual(ok.verdict, 'unavailable', ok.reason);
});

test('固定三席的角色表与聚合判决集不许漂移', () => {
  assert.deepEqual([...JURY_ROLES], ['fact', 'opposition', 'gap']);
  assert.equal(JURY_SEATS, 3);
});
