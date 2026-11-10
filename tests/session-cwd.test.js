/**
 * 会话目录解析 + 门禁取证的隔离性。
 *
 * 两个真实故障（2026-11-10 用户报障）：
 *  1. 在 worktree 里改的，评审却看到主区域 —— 第三方 /review 按 `parent.session.header.cwd`
 *     取 diff，而 header.cwd 是**会话创建时**的值，cd 之后不会更新。
 *  2. 多会话并行时评审互相污染 —— 门禁旧实现在无 cwd 时回退 `process.cwd()`（宿主进程
 *     目录，所有会话共用一份）。
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

test('目录已切走（stale）→ 不发自动评审，并说明第三方会按创建时目录取 diff', async () => {
  setup();
  const agent = makeAgent({ cwd: '/w/main' });
  let reviewed = false;
  await handleTurnStopping(
    { agent, turn: 1 },
    {
      liveCwd: () => '/w/wt/feat',
      collectDiff: async () => configDiff(),
      readJournal: journalUnknown,
      runCommand: async () => { reviewed = true; return { kind: 'success' }; },
    },
  );
  assert.equal(reviewed, false, '审错树比不审更糟');
  const st = statusOf(agent.id).last;
  assert.equal(st.autoReview?.failure, 'cwd-changed-since-session-created');
  assert.match(String(st.hint), /\/review/);
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

test('改动在互不相干的目录 → 用 --cwd 指向写入根发起评审', async () => {
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
  assert.equal(lines.length, 1);
  assert.match(lines[0], /--cwd "\/w\/repo-wt\/feat"/, '必须把写入根作为 --cwd 传下去');
});

test('不支持 --cwd 时（autoReviewCwd=false）→ 拒绝并给出目标路径', async () => {
  setup({ autoReviewCwd: false });
  const agent = makeAgent({ cwd: '/w/repo' });
  let reviewed = false;
  await handleTurnStopping(
    { agent, turn: 1 },
    {
      liveCwd: () => '/w/repo',
      gitRoot: async () => '/w/repo',
      repoRoot: async () => '/w/repo-wt/feat',
      collectDiff: async () => configDiff(),
      readJournal: journalUnknown,
      runCommand: async () => { reviewed = true; return { kind: 'success' }; },
    },
  );
  assert.equal(reviewed, false);
  const st = statusOf(agent.id).last;
  assert.equal(st.autoReview?.failure, 'writes-outside-session-cwd');
  assert.match(String(st.hint), /\/w\/repo-wt\/feat/);
});

test('真实场景回归：改动在主仓库的嵌套工作树里 → 用 --cwd 审那棵工作树', async () => {
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
  assert.equal(lines.length, 1);
  assert.match(lines[0], /--cwd "[^"]*\.worktrees\/feat"/, '必须审写入根，而不是主仓库');
});
