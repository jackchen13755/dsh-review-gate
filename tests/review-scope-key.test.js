/**
 * reviewKeyOf：reviewedDigest / reviewBasis 必须按 (会话, 仓库根) 分区。
 *
 * 为什么（2026-11-11，真实故障模式）：
 *   一个会话可以同时改多个仓库（工作区根是多个仓库的父目录）。基线与「已评审摘要」
 *   只按 sessionId 存的话：
 *     · 换仓后仍拿 A 仓的文件当基线 → reviewScope 里出现 A 仓的文件，
 *       而 agent 正按 B 仓的范围评审（把复审引到不存在的文件，真正该审的反而漏掉）；
 *     · digest 里不含 root，B 仓里内容恰好与 A 仓已评审那版相同时会被判「已评审」——
 *       这是**假放行**（false pass），比串范围更严重：真改动一个字都不会被审。
 *
 * 所以键必须是 (session, root)，且 root 归一化只能有一份实现（normalizeRoot），
 * 否则 isInside 与 reviewKeyOf 会各自漂移：一个把 `/a/` 当 `/a`，另一个不当。
 *
 * 每条都要求能红：F1/F3/F4 的断言在修复前必须失败（见交付说明里的红证据）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as reviewScopeModule from '../lib/review-scope.js';
import { isInside } from '../lib/review-scope.js';
import { applyConfig } from '../lib/config.js';
import { clearGateState, handleTurnStopping, statusOf } from '../lib/gate.js';

const file = (path, added = [], removed = [], status = 'M') => ({ path, status, added, removed });

/** collectDiff 的形状（门禁只读 available / digest / files）。 */
const reviewDiff = (digest, ...files) => ({ available: true, digest, files, totals: { added: 1, removed: 0 } });

function makeAgent({ id = 's1', events = [], cwd = '/tmp/work' } = {}) {
  const steered = [];
  return {
    id,
    steered,
    session: { header: { cwd, delegationDepth: 0 }, snapshotEvents: () => events },
    steer: (m) => steered.push(m),
  };
}

const callEvent = (turn, callId = `c${turn}`) => ({
  type: 'tool/call',
  data: { turn, step: 1, callId, name: 'dsh_code_review', arguments: '{}' },
});
const resultEvent = (turn, callId = `c${turn}`) => ({
  type: 'tool/result',
  data: { turn, step: 2, message: { role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text: '完成' }] } },
});
const journalUnknown = async () => ({ verdict: 'unknown' });

const REPO_A = '/tmp/switch-repo-a';
const REPO_B = '/tmp/switch-repo-b';

function setup() {
  clearGateState();
  applyConfig({ gate: true, gateMaxSteersPerTurn: 1, gateMaxSteersPerSession: 5, steer: true });
}

/**
 * 一个会话先后改了 A、B 两个仓库：repoRoots 返回「此刻正在改的那一个」，
 * collectDiff 按根返回各自的 diff。gitRoot 直接给 undefined —— 本组用例不测
 * 「会话目录 vs 写入根」的判定（那是 review-scope.js 与 session-cwd 的事，
 * 已有 tests 覆盖），这里只测「键要不要带 root」。
 */
function repoDeps(state) {
  return {
    collectDiff: async (dir) => {
      if (dir === REPO_A) return state.diffA();
      if (dir === REPO_B) return state.diffB();
      return { available: false, reason: 'unknown root' };
    },
    repoRoots: async () => [state.current],
    gitRoot: async () => undefined,
    readJournal: journalUnknown,
  };
}

const twoRepoState = () => ({
  current: REPO_A,
  diffA: () => reviewDiff('A1', file('package.json', ['  "a": 1']), file('src/a.js', ['+a'])),
  diffB: () => reviewDiff('B1', file('package.json', ['  "b": 1'])),
});

test('F1 换仓后不得把 repoA 的文件写进 reviewScope', async () => {
  setup();
  const state = twoRepoState();

  // 第 1 轮：在 repoA 里评审成功（写下 A 的基线）。
  const agent1 = makeAgent({ id: 'switch', events: [callEvent(1), resultEvent(1)] });
  await handleTurnStopping({ agent: agent1, turn: 1 }, repoDeps(state));
  assert.equal(statusOf('switch').last?.reviewed, true, '前置：repoA 这一轮必须记为已评审（否则没有基线）');

  // 第 2 轮：会话改到了 repoB。repoB 从没被评审过 → 没有可用基线。
  state.current = REPO_B;
  const agent2 = makeAgent({ id: 'switch', events: [] });
  await handleTurnStopping({ agent: agent2, turn: 2 }, repoDeps(state));

  const status = statusOf('switch');
  assert.equal(status.last?.needsAgentReview, true, '前置：repoB 这一轮必须真的走到「需要评审」');
  assert.equal(
    status.reviewScope,
    null,
    'repoB 没有自己的基线 → 只能全量审；拿 repoA 的基线收窄会把 src/a.js 写进 repoB 的复审范围',
  );
  assert.doesNotMatch(
    String(status.last.hint ?? ''),
    /src\/a\.js/,
    'repoA 的文件不得出现在 repoB 这一轮的复审提示里',
  );
});

test('F2 换仓后的首次评审是全量（hint 不许说「不要全量重审」）', async () => {
  setup();
  const state = twoRepoState();

  const agent1 = makeAgent({ id: 'switch-first', events: [callEvent(1), resultEvent(1)] });
  await handleTurnStopping({ agent: agent1, turn: 1 }, repoDeps(state));
  assert.equal(statusOf('switch-first').last?.reviewed, true, '前置：第 1 轮必须记为已评审');

  state.current = REPO_B;
  const agent2 = makeAgent({ id: 'switch-first', events: [] });
  await handleTurnStopping({ agent: agent2, turn: 2 }, repoDeps(state));

  const hint = String(statusOf('switch-first').last?.hint ?? '');
  assert.doesNotMatch(hint, /不要全量重审/, 'repoB 没有基线 → 提示必须是全量，不能说「只审这几个文件」');
  assert.match(hint, /dsh_code_review/, '全量提示仍要给出该做什么');
});

test('F3 切回 repoA 仍用 repoA 自己的基线（repoB 的评审不得覆盖它）', async () => {
  setup();
  const state = twoRepoState();

  // 第 1 轮：A 评审成功 → A 的基线 = {package.json(a:1), src/a.js(+a)}
  const agent1 = makeAgent({ id: 'switch-back', events: [callEvent(1), resultEvent(1)] });
  await handleTurnStopping({ agent: agent1, turn: 1 }, repoDeps(state));
  assert.equal(statusOf('switch-back').last?.reviewed, true, '前置：第 1 轮必须记为已评审');

  // 第 2 轮：在 B 里也评审成功 → 这份基线与 A 无关，不得覆盖 A 的
  state.current = REPO_B;
  state.diffB = () => reviewDiff('B2', file('package.json', ['  "b": 2']), file('src/b.js', ['+b']));
  const agent2 = makeAgent({ id: 'switch-back', events: [callEvent(2, 'c2'), resultEvent(2, 'c2')] });
  await handleTurnStopping({ agent: agent2, turn: 2 }, repoDeps(state));
  assert.equal(statusOf('switch-back').last?.reviewed, true, '前置：第 2 轮（repoB）也必须记为已评审');

  // 第 3 轮：切回 A，只改了 A 的 package.json
  state.current = REPO_A;
  state.diffA = () => reviewDiff('A3', file('package.json', ['  "a": 2']), file('src/a.js', ['+a']));
  const agent3 = makeAgent({ id: 'switch-back', events: [] });
  await handleTurnStopping({ agent: agent3, turn: 3 }, repoDeps(state));

  const status = statusOf('switch-back');
  assert.equal(status.last?.needsAgentReview, true, '前置：第 3 轮必须真的走到「需要评审」');
  assert.deepEqual(
    status.reviewScope,
    { mode: 'narrow', files: ['package.json'], reason: 'changed' },
    'A 的基线必须还在：若被 B 的评审覆盖，src/b.js 会被当成「被删掉」而混进 A 的复审范围',
  );
});

test('F4 repoA 已评审的 digest 不得放行 repoB 的同样内容', async () => {
  setup();
  const state = twoRepoState();
  // 两个仓库里出现**完全相同**的一版改动（digest 也一样）：内容相同不等于同一个仓库的同一份工作。
  state.diffA = () => reviewDiff('SAME', file('package.json', ['  "x": 1']));
  state.diffB = () => reviewDiff('SAME', file('package.json', ['  "x": 1']));

  const agent1 = makeAgent({ id: 'digest-switch', events: [callEvent(1), resultEvent(1)] });
  await handleTurnStopping({ agent: agent1, turn: 1 }, repoDeps(state));
  assert.equal(statusOf('digest-switch').last?.reviewed, true, '前置：repoA 这一版必须记为已评审');

  state.current = REPO_B;
  const agent2 = makeAgent({ id: 'digest-switch', events: [] });
  const text = await handleTurnStopping({ agent: agent2, turn: 2 }, repoDeps(state));

  const status = statusOf('digest-switch');
  assert.ok(text, 'repoB 的这版改动从未被评审过，必须拦下来（按 A 的 digest 放行 = 假放行）');
  assert.equal(status.last?.reviewed, false, 'repoB 这一轮不得被报成已评审');
  assert.equal(status.last?.needsAgentReview, true, 'repoB 这一轮必须要求评审');
});

// ---------------------------------------------------------------- 纯函数 reviewKeyOf

test('F5 不同 root 不同键；同 root 尾斜杠同键；不同会话不同键', () => {
  const { reviewKeyOf } = reviewScopeModule;
  assert.equal(typeof reviewKeyOf, 'function', 'review-scope.js 必须导出纯函数 reviewKeyOf(sessionId, root)');

  assert.notEqual(reviewKeyOf('s', '/tmp/a'), reviewKeyOf('s', '/tmp/b'), '不同 root 必须是不同的键');
  assert.equal(reviewKeyOf('s', '/tmp/a/'), reviewKeyOf('s', '/tmp/a'), '同一个 root 带尾斜杠必须归一成同一个键');
  assert.equal(reviewKeyOf('s', '/tmp/a///'), reviewKeyOf('s', '/tmp/a'), '多个尾斜杠同样归一');
  assert.notEqual(reviewKeyOf('s1', '/tmp/a'), reviewKeyOf('s2', '/tmp/a'), '不同会话必须是不同的键');
  assert.notEqual(reviewKeyOf('s', '/'), reviewKeyOf('s', ''), '根目录 `/` 与空串不是同一个键');

  // 分隔符必须是「不会出现在路径里的字符」，否则 session 与 root 拼接会互相串味
  const key = reviewKeyOf('s', '/tmp/a');
  assert.equal(key.split('\u0000').length, 2, '必须是 NUL 分隔的两段（session 段 + root 段）');

  // 占位符彼此可区分，且不与任何真实 root 相撞
  const missing = reviewKeyOf('s', undefined);
  const empty = reviewKeyOf('s', '');
  const nonString = reviewKeyOf('s', 42);
  assert.equal(new Set([missing, empty, nonString]).size, 3, 'undefined / 空串 / 非字符串必须彼此可区分（否则「不知道根」会被并成同一个键）');
  for (const placeholder of [missing, empty, nonString]) {
    assert.notEqual(placeholder, reviewKeyOf('s', '/tmp/a'), '占位符不得与真实 root 撞键');
  }
});

test('F6 root 为脏值时 reviewKeyOf 不抛，且始终返回字符串', () => {
  const { reviewKeyOf } = reviewScopeModule;
  assert.equal(typeof reviewKeyOf, 'function', 'review-scope.js 必须导出纯函数 reviewKeyOf(sessionId, root)');

  for (const badRoot of [undefined, null, '', 0, 42, true, {}, [], () => {}]) {
    let key;
    assert.doesNotThrow(() => { key = reviewKeyOf('s', badRoot); }, `root=${String(badRoot)} 时不该抛`);
    assert.equal(typeof key, 'string');
    assert.notEqual(key, '');
  }
  for (const badSession of [undefined, null, '', 42, {}, []]) {
    let key;
    assert.doesNotThrow(() => { key = reviewKeyOf(badSession, '/tmp/a'); }, `session=${String(badSession)} 时不该抛`);
    assert.equal(typeof key, 'string');
  }
});

test('F6 isInside 与 reviewKeyOf 共用同一份归一化（尾斜杠不会一边认一边不认）', () => {
  // 归一化只有一份实现：isInside 的口径变了，reviewKeyOf 的键必须跟着变，反之亦然。
  assert.equal(isInside('/tmp/a/', '/tmp/a'), true);
  assert.equal(isInside('/tmp/a', '/tmp/a///'), true);
  assert.equal(isInside('', '/tmp/a'), false);
  assert.equal(isInside('/tmp/a', ''), false);
  assert.equal(isInside(undefined, '/tmp/a'), false);
});
