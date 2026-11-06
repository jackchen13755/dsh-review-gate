/**
 * 评审工具分流：dsh_code_review（独立评审）为主干，review_brief（自审）只能补位。
 *
 * 这两条以前没有判据，于是两件事都能静默通过：
 *  1. 本会话明明有 dsh_code_review，却只用 review_brief 收工 —— 自审冒充独立评审；
 *  2. 取证成功但确认无改动时，状态里没有任何标记 —— 与「门禁根本没跑」无法区分。
 *
 * 每个用例都设计成能红：把 lib/verdict.js 的 reviewTool 分支删掉、或把 lib/gate.js 的
 * no-diff-evidence 分支删掉，这里必有一条变红。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { decideReview, REASON_TEXT } from '../lib/verdict.js';
import { applyConfig } from '../lib/config.js';
import { handleTurnStopping, clearGateState, statusOf } from '../lib/gate.js';

// ------------------------------------------------------------------ 夹具

function makeAgent({ id = 's1', depth = 0, events = [], cwd = '/tmp/work' } = {}) {
  const steered = [];
  return {
    id,
    steered,
    session: {
      header: { cwd, delegationDepth: depth },
      snapshotEvents: () => events,
    },
    steer: (m) => steered.push(m),
  };
}

const ev = (turn, callId, name) => ({
  type: 'tool/call',
  data: { turn, step: 1, callId, name, arguments: '{}' },
});
const res = (turn, callId, text = '完成') => ({
  type: 'tool/result',
  data: { turn, step: 2, message: { role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text }] } },
});

/** 会触发门禁的改动：改根级 package.json。 */
const configDiff = (digest = 'D1') => ({
  available: true,
  digest,
  files: [{ path: 'package.json', status: 'M', added: ['  "x": 1'], removed: [] }],
  totals: { added: 1, removed: 0 },
});

/** 取证成功但确认没有改动。 */
const cleanDiff = (digest = 'E1') => ({
  available: true,
  digest,
  files: [],
  totals: { added: 0, removed: 0 },
});

function setup(overrides = {}) {
  clearGateState();
  applyConfig({ gate: true, gateMaxSteersPerTurn: 1, gateMaxSteersPerSession: 3, ...overrides });
}

const journalUnknown = async () => ({ verdict: 'unknown' });

// ------------------------------------------------- 判决层（纯函数，合成输入）

test('判决：本会话有 dsh_code_review 却只用 review_brief → weak-tool（拦）', () => {
  const d = decideReview({
    callSeen: true,
    reviewTool: 'review_brief',
    reviewToolAvailable: true,
  });
  assert.equal(d.reviewed, false);
  assert.equal(d.reason, 'weak-tool');
  assert.match(REASON_TEXT['weak-tool'], /自审/, '原因文案要说清为什么不算');
});

test('判决：本会话没有 dsh_code_review → 用 review_brief 放行，但必须标注为自审', () => {
  const d = decideReview({
    callSeen: true,
    reviewTool: 'review_brief',
    reviewToolAvailable: false,
  });
  assert.equal(d.reviewed, true);
  assert.equal(d.reason, 'brief-self-review', '放行可以，但不能与独立评审混同');
  assert.notEqual(
    REASON_TEXT['brief-self-review'],
    REASON_TEXT.ok,
    '文案也必须不同：外部只看 status 时不能再把自审读成「已评审」',
  );
});

test('判决：无法判定工具可用性（undefined）→ 按不可用放行，但要标注', () => {
  const d = decideReview({ callSeen: true, reviewTool: 'review_brief' });
  assert.equal(d.reviewed, true);
  assert.equal(d.reason, 'brief-self-review');
});

test('判决：真用 dsh_code_review → ok（不能误伤主干路径）', () => {
  const d = decideReview({
    callSeen: true,
    reviewTool: 'dsh_code_review',
    reviewToolAvailable: true,
  });
  assert.equal(d.reviewed, true);
  assert.equal(d.reason, 'ok');
});

test('判决：没记工具名时保持旧行为（ok），不因新增字段而误拦', () => {
  assert.equal(decideReview({ callSeen: true }).reason, 'ok');
  assert.equal(decideReview({ callSeen: true, reviewTool: null }).reason, 'ok');
});

test('判决：weak-tool 不能盖过更硬的问题（调用失败优先）', () => {
  const d = decideReview({ callSeen: false, resultOk: false, reviewTool: 'review_brief', reviewToolAvailable: true });
  assert.equal(d.reason, 'call-failed', '失败原因对排查更有用，不能被 weak-tool 顶掉');
});

// ------------------------------------------------------ 门禁层（端到端）

test('端到端：前回合用过 A，本回合只调 review_brief → 必须 steer，且文案指向 A', async () => {
  setup();
  const agent = makeAgent({
    events: [
      ev(1, 'a1', 'dsh_code_review'),
      res(1, 'a1'),
      ev(2, 'b1', 'review_brief'),
      res(2, 'b1', '这是取证简报'),
    ],
  });
  const text = await handleTurnStopping(
    { agent, turn: 2 },
    { collectDiff: async () => configDiff('D2'), readJournal: journalUnknown },
  );
  assert.ok(text, '自审不能顶替独立评审');
  assert.equal(agent.steered.length, 1);
  const status = statusOf('s1');
  assert.equal(status.last.reason, 'weak-tool');
  assert.match(text, /自审/, 'steer 文本必须解释原因');
});

test('端到端：本会话从无 A（专家子会话）→ 用 review_brief 放行，不打扰', async () => {
  setup();
  const agent = makeAgent({
    events: [ev(1, 'b1', 'review_brief'), res(1, 'b1')],
  });
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => configDiff('D1'), readJournal: journalUnknown },
  );
  assert.equal(text, undefined, '工具不存在时拦死 = 把人卡死，这条不能改坏');
  assert.equal(agent.steered.length, 0);
  assert.equal(statusOf('s1').last.reason, 'brief-self-review');
});

test('端到端：真用 A 评审 → 放行，reason 为 ok', async () => {
  setup();
  const agent = makeAgent({ events: [ev(1, 'a1', 'dsh_code_review'), res(1, 'a1')] });
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => configDiff('D1'), readJournal: journalUnknown },
  );
  assert.equal(text, undefined);
  assert.equal(statusOf('s1').last.reason, 'ok');
});

test('端到端：取证成功但确认无改动 → 状态必须留下 no-diff-evidence（不再与「没跑」混淆）', async () => {
  setup();
  const agent = makeAgent({ events: [] });
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => cleanDiff('E1'), readJournal: journalUnknown },
  );
  assert.equal(text, undefined, '无改动时放行（纯讨论回合不能被卡死）');
  assert.equal(agent.steered.length, 0);
  const status = statusOf('s1');
  assert.equal(status.last.skipped, 'no-diff-evidence');
  assert.equal(status.last.noChange, true);
  assert.equal(status.last.source, 'git');
});

test('端到端：A 只失败过（从未成功）→ review_brief 仍放行，不能把刚失败的工具再推回去', async () => {
  setup();
  const agent = makeAgent({
    events: [
      ev(1, 'a1', 'dsh_code_review'),
      res(1, 'a1', 'Error: 审查失败'),
      ev(2, 'b1', 'review_brief'),
      res(2, 'b1'),
    ],
  });
  const text = await handleTurnStopping(
    { agent, turn: 2 },
    { collectDiff: async () => configDiff('D2'), readJournal: journalUnknown },
  );
  assert.equal(text, undefined, '「出现过」不等于「可用」：失败过的工具不能当可用推回去');
  assert.equal(statusOf('s1').last.reason, 'brief-self-review');
});

test('端到端：读不到改动清单（files 畸形）→ 状态必须标 undetermined', async () => {
  setup();
  const agent = makeAgent({ events: [] });
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    {
      collectDiff: async () => ({ available: true, digest: 'U1', files: undefined, totals: { added: 0, removed: 0 } }),
      readJournal: journalUnknown,
    },
  );
  assert.equal(text, undefined, '读不到清单时按保守放行，但必须留下痕迹');
  const status = statusOf('s1');
  assert.equal(status.last.undetermined, true, '「读不到」必须在状态里看得见');
});

test('端到端：降级取证（没看到写入）也要标来源，不能伪装成 git 干净', async () => {
  setup();
  const agent = makeAgent({ events: [] });
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    {
      collectDiff: async () => ({ available: true, digest: 'E2', files: [], totals: { added: 0, removed: 0 }, partial: true }),
      readJournal: journalUnknown,
    },
  );
  assert.equal(text, undefined);
  assert.equal(statusOf('s1').last.source, 'observed');
});
