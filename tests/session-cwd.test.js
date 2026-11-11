/**
 * 会话目录解析 + 门禁取证的隔离性。
 *
 * 两个真实故障（2026-11-10 用户报障）：
 *  1. 在 worktree 里改的，评审却看到主区域 —— 会话 header.cwd 是**创建时**的值，
 *     cd 之后不会更新，按它取 diff 会审错树。
 *  2. 多会话并行时评审互相污染 —— 门禁旧实现在无 cwd 时回退 `process.cwd()`（宿主进程
 *     目录，所有会话共用一份）。
 *
 * 2026-11-11 契约变更后，门禁不再代跑 /review（见 tests/no-command-trigger.test.js）。
 * 但「评审必须指向正确的树」这条本意不变，只是载体从「命令行里的 --cwd」变成
 * `statusOf(sid).last.reviewRoot`：门禁负责算准并在状态里写明该审哪棵树，
 * 再由此刻唯一被允许发起评审的一方（agent 调 dsh_code_review，或用户敲 /review）照着做。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSessionCwd } from '../lib/session-cwd.js';
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

const configDiff = (digest = 'X1') => ({
  available: true,
  digest,
  files: [{ path: 'package.json', status: 'M', added: ['  "a": 1'], removed: [] }],
  totals: { added: 1, removed: 0 },
});

const journalUnknown = async () => ({ verdict: 'unknown' });

function setup(overrides = {}) {
  clearGateState();
  applyConfig({ gate: true, gateMaxSteersPerTurn: 1, gateMaxSteersPerSession: 3, autoReview: true, steer: false, autoReviewInput: '审查未提交的更改', autoReviewTimeoutMs: 500, ...overrides });
}

// ------------------------------------------------------------------ 纯函数边界

test('实时值与 header 一致 → source=live，不算 stale', () => {
  assert.deepEqual(
    resolveSessionCwd({ live: '/w/wt/feat', header: '/w/wt/feat' }),
    { cwd: '/w/wt/feat', source: 'live', stale: false },
  );
});

test('实时值与 header 不一致（会话中途切过目录）→ stale=true', () => {
  const r = resolveSessionCwd({ live: '/w/wt/feat', header: '/w/main' });
  assert.equal(r.cwd, '/w/wt/feat');
  assert.equal(r.source, 'live');
  assert.equal(r.stale, true);
});

test('没有实时值 → 退回 header，但标 source=header', () => {
  for (const live of [undefined, null, '', '   ', 42]) {
    const r = resolveSessionCwd({ live, header: '/w/main' });
    assert.equal(r.cwd, '/w/main');
    assert.equal(r.source, 'header');
    assert.equal(r.stale, false);
  }
});

test('两边都没有 → cwd=undefined（绝不回退 process.cwd）', () => {
  for (const input of [undefined, null, {}, { live: '', header: '' }]) {
    const r = resolveSessionCwd(input);
    assert.equal(r.cwd, undefined);
    assert.equal(r.source, 'none');
  }
});

test('空白字符串不当目录（避免 git 在空 cwd 上跑）', () => {
  assert.equal(resolveSessionCwd({ live: '   ', header: '  ' }).cwd, undefined);
});

// ------------------------------------------------------------------ 门禁取证隔离

test('门禁用实时目录取证：live 与 header 不同时，diff 从 live 目录取', async () => {
  setup();
  const agent = makeAgent({ cwd: '/w/main' });
  const seen = [];
  await handleTurnStopping(
    { agent, turn: 1 },
    {
      liveCwd: () => '/w/wt/feat',
      collectDiff: async (cwd) => { seen.push(cwd); return configDiff(); },
      readJournal: journalUnknown,
      runCommand: async () => ({ kind: 'success' }),
    },
  );
  assert.deepEqual(seen, ['/w/wt/feat'], '必须用实时目录，不能用 header.cwd');
});

test('拿不到任何目录 → 直接放行且不取证（不再用进程 cwd）', async () => {
  setup();
  const agent = makeAgent({ cwd: '' });
  let called = false;
  await handleTurnStopping(
    { agent, turn: 1 },
    {
      liveCwd: () => undefined,
      collectDiff: async () => { called = true; return configDiff(); },
      readJournal: journalUnknown,
      runCommand: async () => ({ kind: 'success' }),
    },
  );
  assert.equal(called, false, '没有目录就不该取证');
  assert.equal(statusOf(agent.id).last.skipped, 'no-cwd');
});

test('目录已切走（stale）→ 不替模型发起评审，改为让 agent 自己按实时目录调工具', async () => {
  setup();
  const agent = makeAgent({ cwd: '/w/main' });
  // 不代跑 /review 之后，「不替模型发起」由 runCommand 零调用来钉；
  // 该审哪棵树仍必须由门禁算准（reviewRoot 用实时目录，不是 header.cwd）。
  const lines = [];
  await handleTurnStopping(
    { agent, turn: 1 },
    {
      liveCwd: () => '/w/wt/feat',
      collectDiff: async () => configDiff(),
      readJournal: journalUnknown,
      runCommand: async (line) => { lines.push(line); return { kind: 'success' }; },
    },
  );
  assert.deepEqual(lines, [], '审错树比不审更糟：门禁不得替它发起评审');
  const st = statusOf(agent.id).last;
  assert.equal(st.needsAgentReview, true, '仍必须把「该评审了」写进状态');
  assert.equal(st.reviewRoot, '/w/wt/feat', '必须指向实时目录，不能用 header.cwd=/w/main');
  assert.equal(st.sessionCwd, '/w/wt/feat');
  assert.match(String(st.hint), /dsh_code_review/, '提示要指向 agent 自己能调的工具');
  // 旧说法「第三方会按创建时目录取 diff」已过时：现在发起方是 agent 自己，
  // 它按 reviewRoot 指定目录即可，不能再把责任推给第三方的 header 取值。
  assert.doesNotMatch(String(st.hint), /第三方/, 'hint 不得再声称第三方会按 header 取 diff');
});

test('两个会话各用各的目录，互不串味', async () => {
  setup();
  const seen = [];
  const run = (agent, live) => handleTurnStopping(
    { agent, turn: 1 },
    { liveCwd: () => live, collectDiff: async (cwd) => { seen.push(cwd); return configDiff(); }, readJournal: journalUnknown, runCommand: async () => ({ kind: 'success' }) },
  );
  await run(makeAgent({ id: 'a', cwd: '/w/a' }), '/w/a');
  await run(makeAgent({ id: 'b', cwd: '/w/b' }), '/w/b');
  assert.deepEqual(seen, ['/w/a', '/w/b']);
});

// ---------------------------------------------- 评审范围以「写过的文件」为准

import { isInside, resolveReviewRoot } from '../lib/review-scope.js';

test('isInside：相等 / 子路径 / 兄弟目录', () => {
  assert.equal(isInside('/a/b', '/a/b'), true);
  assert.equal(isInside('/a/b/c', '/a/b'), true);
  assert.equal(isInside('/a/bc', '/a/b'), false, '前缀相同但不是子目录');
  assert.equal(isInside('/a', '/a/b'), false);
  for (const bad of [undefined, null, '', 42]) assert.equal(isInside(bad, '/a'), false);
});

test('嵌套工作树（<repo>/.worktrees/feat）→ 仍是 mismatch：git 根不同，主仓库 diff 看不到', () => {
  const r = resolveReviewRoot({
    sessionCwd: '/w/repo',
    sessionRoot: '/w/repo',
    observedRoot: '/w/repo/.worktrees/feat',
  });
  assert.equal(r.root, '/w/repo/.worktrees/feat');
  assert.equal(r.source, 'observed');
  assert.equal(r.mismatch, true, 'toplevel 不同就是不同工作树（真实踩过：主仓库 .gitignore 忽略 .worktrees/）');
  assert.equal(r.basis, 'git-root');
});

test('同一个 git 根 → 不算 mismatch', () => {
  const r = resolveReviewRoot({ sessionCwd: '/w/repo/src', sessionRoot: '/w/repo', observedRoot: '/w/repo' });
  assert.equal(r.mismatch, false);
});

test('拿不到会话 git 根时退化为路径判断（已知局限会漏嵌套工作树）', () => {
  const r = resolveReviewRoot({ sessionCwd: '/w/repo', observedRoot: '/w/repo/.worktrees/feat' });
  assert.equal(r.basis, 'path');
  assert.equal(r.mismatch, false);
});

test('写入根与会话目录互不包含（例：主仓库 vs 平级 worktree）→ mismatch', () => {
  const r = resolveReviewRoot({ sessionCwd: '/w/repo', observedRoot: '/w/repo-wt/feat' });
  assert.equal(r.mismatch, true);
});

test('没有写入根 → 退回会话目录，不算 mismatch', () => {
  assert.deepEqual(resolveReviewRoot({ sessionCwd: '/w/repo' }), { root: '/w/repo', source: 'session', mismatch: false, basis: 'none' });
});

test('两边都没有 → none', () => {
  assert.deepEqual(resolveReviewRoot({}), { root: undefined, source: 'none', mismatch: false, basis: 'none' });
});

test('真实场景回归：改动在工作树子目录时，取证用写入根而不是会话目录', async () => {
  setup();
  const agent = makeAgent({ cwd: '/w/repo' });
  const seen = [];
  await handleTurnStopping(
    { agent, turn: 1 },
    {
      liveCwd: () => '/w/repo',
      gitRoot: async () => '/w/repo',
      repoRoot: async () => '/w/repo/.worktrees/feat',
      collectDiff: async (cwd) => { seen.push(cwd); return configDiff(); },
      readJournal: journalUnknown,
      runCommand: async () => ({ kind: 'success' }),
    },
  );
  assert.deepEqual(seen, ['/w/repo/.worktrees/feat'], '必须按写入根取证');
});

test('改动在互不相干的目录 → status 里的 reviewRoot 指向写入根（不代跑评审）', async () => {
  setup();
  const agent = makeAgent({ cwd: '/w/repo' });
  const lines = [];
  await handleTurnStopping(
    { agent, turn: 1 },
    {
      liveCwd: () => '/w/repo',
      gitRoot: async () => '/w/repo',
      repoRoot: async () => '/w/repo-wt/feat',
      collectDiff: async () => configDiff(),
      readJournal: journalUnknown,
      runCommand: async (line) => { lines.push(line); return { kind: 'success' }; },
    },
  );
  const st = statusOf(agent.id).last;
  assert.equal(st.reviewRoot, '/w/repo-wt/feat', '评审范围必须跟写入根走，不是会话目录');
  assert.equal(st.needsAgentReview, true, '必须把「该评审了」写进状态');
  assert.deepEqual(lines, [], '门禁不得代跑 /review');
});

test('不支持 --cwd 时（autoReviewCwd=false）→ 不代跑，改为把目标写入根写进 last', async () => {
  setup({ autoReviewCwd: false });
  const agent = makeAgent({ cwd: '/w/repo' });
  // 旧契约：不支持 --cwd 就「拒绝自动评审 + 提示去目标目录开会话」。
  // 新契约下门禁本来就不代跑命令，但它仍必须把目标路径算准并留下——
  // agent 据此给 dsh_code_review 指定正确的树，否则又会审错地方。
  const lines = [];
  await handleTurnStopping(
    { agent, turn: 1 },
    {
      liveCwd: () => '/w/repo',
      gitRoot: async () => '/w/repo',
      repoRoot: async () => '/w/repo-wt/feat',
      collectDiff: async () => configDiff(),
      readJournal: journalUnknown,
      runCommand: async (line) => { lines.push(line); return { kind: 'success' }; },
    },
  );
  assert.deepEqual(lines, [], '门禁不得代跑 /review');
  const st = statusOf(agent.id).last;
  assert.equal(st.reviewRoot, '/w/repo-wt/feat', '目标树必须留在状态里，供发起方指定');
  assert.equal(st.needsAgentReview, true, '必须把「该评审了」写进状态');
  assert.equal(st.steered, false, '不得推回');
});

test('真实场景回归：改动在主仓库的嵌套工作树里 → reviewRoot 指向那棵工作树', async () => {
  setup();
  const agent = makeAgent({ cwd: '/w/repo' });
  const lines = [];
  await handleTurnStopping(
    { agent, turn: 1 },
    {
      liveCwd: () => '/w/repo',
      gitRoot: async () => '/w/repo',
      repoRoot: async () => '/w/repo/.worktrees/feat',
      collectDiff: async () => configDiff(),
      readJournal: journalUnknown,
      runCommand: async (line) => { lines.push(line); return { kind: 'success' }; },
    },
  );
  const st = statusOf(agent.id).last;
  assert.equal(st.reviewRoot, '/w/repo/.worktrees/feat', '必须审写入根，而不是主仓库');
  assert.equal(st.needsAgentReview, true);
  assert.deepEqual(lines, [], '门禁不得代跑 /review');
});
