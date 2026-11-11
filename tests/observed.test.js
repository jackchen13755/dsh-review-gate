import test from 'node:test';
import assert from 'node:assert/strict';

import { applyConfig } from '../lib/config.js';
import { handleTurnStopping, clearGateState } from '../lib/gate.js';
import {
  clearObserved,
  latestObservedPath,
  observedPaths,
  observedSnapshot,
  recordWrite,
  repoRootFromObserved,
  repoRootsFromObserved,
  resolveSessionId,
} from '../lib/observed.js';

// ---------------------------------------------------------------- 基础

test('resolveSessionId：优先 session.id，其次 session.header.id，最后 agent.id', () => {
  assert.equal(resolveSessionId({ session: { id: 'sess-1' } }), 'sess-1');
  assert.equal(resolveSessionId({ session: { header: { id: 'hdr-1' } } }), 'hdr-1');
  assert.equal(resolveSessionId({ agent: { id: 'agent-1' } }), 'agent-1');
  assert.equal(resolveSessionId({ id: 'bare-1' }), 'bare-1');
  assert.equal(resolveSessionId(null), undefined);
  assert.equal(resolveSessionId({}), undefined);
  // tools/execute 侧可能把 agent 挂在执行上下文里
  assert.equal(resolveSessionId({ agent: { session: { id: 'nested' } } }), 'nested');
});

test('recordWrite：忽略空值与非法输入，不抛', () => {
  clearObserved();
  recordWrite('s1', '');
  recordWrite('s1', undefined);
  recordWrite(undefined, 'a.js');
  assert.deepEqual(observedPaths('s1'), []);
  recordWrite('s1', 'package.json');
  assert.deepEqual(observedPaths('s1'), ['package.json']);
});

test('observedSnapshot：没有观察记录时 available=false（交给上层 fail-open）', async () => {
  clearObserved();
  const snap = await observedSnapshot('nope');
  assert.equal(snap.available, false);
  assert.match(snap.reason, /no observed writes/);
});

test('observedSnapshot：有记录时给出 partial 快照，且 added 留空（不让内容类规则误触发）', async () => {
  clearObserved();
  recordWrite('s2', '/repo/package.json');
  const snap = await observedSnapshot('s2', { readFile: async () => 'if (a) { x.filter(y) }' });

  assert.equal(snap.available, true);
  assert.equal(snap.partial, true);
  assert.equal(snap.source, 'session');
  assert.equal(snap.files.length, 1);
  assert.deepEqual(snap.files[0].added, [], '降级模式不能拿全文当成「新增行」，否则判定表达式规则会大面积误触发');
  assert.match(snap.digest, /^[0-9a-f]{64}$/);
});

test('observedSnapshot 摘要对内容敏感：改了内容摘要必须变（新鲜度靠它）', async () => {
  clearObserved();
  recordWrite('s3', '/repo/a.js');
  const a = await observedSnapshot('s3', { readFile: async () => 'v1' });
  const b = await observedSnapshot('s3', { readFile: async () => 'v2' });
  assert.notEqual(a.digest, b.digest);
});

// ---------------------------------------------------------------- 门禁集成

const noGit = async () => ({ available: false, reason: 'not a git work tree', files: [], totals: { added: 0, removed: 0 }, digest: '' });
const journalUnknown = async () => ({ verdict: 'unknown' });

function makeAgent({ id = 'agent-1', sid = 'sess-1', events = [], cwd = '/repo' } = {}) {
  const steered = [];
  return {
    id,
    steered,
    session: { id: sid, header: { cwd, delegationDepth: 0 }, snapshotEvents: () => events },
    steer: (m) => steered.push(m),
  };
}

const callEvent = (turn) => ({ type: 'tool/call', data: { turn, step: 1, callId: 'c1', name: 'dsh_code_review', arguments: '{}' } });
const resultEvent = (turn) => ({ type: 'tool/result', data: { turn, step: 2, message: { role: 'tool', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: '完成' }] } } });

test('非 git 目录：写了配置类文件 → 降级模式也要拦住', async () => {
  clearGateState();
  clearObserved();
  applyConfig({ gate: true });
  recordWrite('sess-1', '/repo/package.json');

  const agent = makeAgent();
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: noGit, readJournal: journalUnknown, readFile: async () => '{}' },
  );

  assert.ok(text, '降级取证必须能触发');
  assert.match(text, /config/);
  assert.match(text, /降级模式/, '必须如实告知取证是降级的');
  assert.equal(agent.steered.length, 1);
});

test('非 git 目录：只写了普通源码文件 → 不该拦（避免变成噪音）', async () => {
  clearGateState();
  clearObserved();
  applyConfig({ gate: true });
  recordWrite('sess-1', '/repo/src/a.js');

  const agent = makeAgent();
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: noGit, readJournal: journalUnknown, readFile: async () => 'const a = 1' },
  );
  assert.equal(text, undefined);
});

test('非 git 目录：跨两个目录 → 命中 cross-module', async () => {
  clearGateState();
  clearObserved();
  applyConfig({ gate: true });
  recordWrite('sess-1', '/repo/apps/a/x.js');
  recordWrite('sess-1', '/repo/packages/b/y.js');

  const agent = makeAgent();
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: noGit, readJournal: journalUnknown, readFile: async () => 'x' },
  );
  assert.ok(text);
  assert.match(text, /cross-module/);
});

test('非 git 目录：安全敏感路径 → 命中 security', async () => {
  clearGateState();
  clearObserved();
  applyConfig({ gate: true });
  recordWrite('sess-1', '/repo/src/auth/token.js');

  const agent = makeAgent();
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: noGit, readJournal: journalUnknown, readFile: async () => 'x' },
  );
  assert.ok(text);
  assert.match(text, /security/);
});

test('降级模式下新鲜度仍生效：评审后又改同一文件必须再拦', async () => {
  clearGateState();
  clearObserved();
  applyConfig({ gate: true });
  recordWrite('sess-1', '/repo/package.json');

  // 第 1 回合：有评审调用 → 通过
  const a1 = makeAgent({ events: [callEvent(1), resultEvent(1)] });
  const t1 = await handleTurnStopping(
    { agent: a1, turn: 1 },
    { collectDiff: noGit, readJournal: journalUnknown, readFile: async () => 'v1' },
  );
  assert.equal(t1, undefined);

  // 第 2 回合：没有新评审，且内容变了 → 摘要变化 → 必须再拦
  const a2 = makeAgent({ events: [callEvent(1), resultEvent(1)] });
  const t2 = await handleTurnStopping(
    { agent: a2, turn: 2 },
    { collectDiff: noGit, readJournal: journalUnknown, readFile: async () => 'v2' },
  );
  assert.ok(t2, '降级模式下「评审后又改」也必须拦住');
});

test('没有观察记录且非 git → 放行，并把 skipped 记为 no-diff', async () => {
  clearGateState();
  clearObserved();
  applyConfig({ gate: true });

  const agent = makeAgent();
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: noGit, readJournal: journalUnknown, readFile: async () => 'x' },
  );
  assert.equal(text, undefined);
  assert.equal(agent.steered.length, 0);
});

// ------------------------------------------------------------ 新增 vs 修改（structural 在降级模式下的前提）

test('降级模式：写入前不存在 → 记为 A（新增），structural 才能触发', async () => {
  clearObserved();
  // created 由调用方在**写入之前**判定并传入（看当前文件是否存在是错的：
  // 回合结束时新文件必然已存在）
  recordWrite('new-file', '/repo/lib/newmod.js', { created: true });
  const snap = await observedSnapshot('new-file', {
    readFile: async () => 'export const x = 1',
    cwd: '/repo',
  });
  assert.equal(snap.files[0].status, 'A', '写入前不存在的文件必须记成 A，否则 structural 永不触发');
});

test('降级模式：文件本来就有 → 记为 M（修改），不误判为新增', async () => {
  clearObserved();
  recordWrite('mod-file', '/repo/lib/a.js');
  const snap = await observedSnapshot('mod-file', {
    readFile: async () => 'const a = 1',
    exists: async () => true,
    cwd: '/repo',
  });
  assert.equal(snap.files[0].status, 'M', '改一行代码不等于新增文件');
});

test('降级模式：新增代码文件 → 真的能命中 structural（这是本轮修的缺口）', async () => {
  const { classifyTrigger } = await import('../lib/trigger.js');
  clearObserved();
  recordWrite('struct', '/repo/lib/brand-new.js', { created: true });
  const snap = await observedSnapshot('struct', {
    readFile: async () => 'export function hello() {}',
    cwd: '/repo',
  });
  const cls = classifyTrigger(snap);
  assert.ok(cls.reasons.includes('structural'), `应命中 structural，实际: ${cls.reasons.join(',')}`);
});

test('降级模式：新增非代码文件（.md）→ 不命中 structural', async () => {
  const { classifyTrigger } = await import('../lib/trigger.js');
  clearObserved();
  recordWrite('struct-md', '/repo/docs/note.md', { created: true });
  const snap = await observedSnapshot('struct-md', {
    readFile: async () => '# note',
    cwd: '/repo',
  });
  const cls = classifyTrigger(snap);
  assert.equal(cls.reasons.includes('structural'), false, '文档新增不该要求 lens');
});

// ------------------------------------------------- 最近写入语义与多仓库（2026-11-11）

/**
 * 这三条守的是同一个故障：「多仓库工作区里，门禁审的不是你正在改的那个项目」。
 *
 * 关键前提（容易写错）：`Map#set` 对**已存在的键不会移动位置**，所以不主动维护顺序，
 * 键序就退化成「首次写入顺序」。而 repoRootsFromObserved 正是靠这个顺序判断
 * 「此刻在改哪个仓库」。用「写 A → 写 B → 再写 A」这种输入才能暴露它，
 * 只写一次 A、一次 B 是测不出来的（那两种输入下两种实现结果相同）。
 */
test('recordWrite 刷新最近写入顺序：重复写同一文件会移到末尾', () => {
  clearObserved();
  recordWrite('lru', '/r/a.js');
  recordWrite('lru', '/r/b.js');
  recordWrite('lru', '/r/a.js');
  assert.deepEqual(observedPaths('lru'), ['/r/b.js', '/r/a.js'], '再次写 a.js 必须把它刷到末尾');
  assert.equal(latestObservedPath('lru'), '/r/a.js');
  clearObserved();
});

test('recordWrite 保留历史的 created 标记（重复写入不丢「新增」事实）', async () => {
  clearObserved();
  recordWrite('keep', '/r/new.js', { created: true });
  recordWrite('keep', '/r/new.js', { created: false });
  const snap = await observedSnapshot('keep', { readFile: async () => 'x' });
  const file = snap.files.find(f => f.absPath === '/r/new.js');
  assert.equal(file.status, 'A', '第一次判为新增后，再改它仍然是新增');
  clearObserved();
});

test('repoRootsFromObserved：返回全部仓库根，最近写入的排最前，不丢另一个仓库', async () => {
  clearObserved();
  recordWrite('multi', '/work/repoA/src/a.js');
  recordWrite('multi', '/work/repoB/src/b.js');
  recordWrite('multi', '/work/repoA/src/c.js');
  const exists = async p => p === '/work/repoA/.git' || p === '/work/repoB/.git';
  const roots = await repoRootsFromObserved('multi', { exists });
  // 两个都要在（只返回一个 = 静默漏审另一个），且最近改的 A 排第一。
  assert.deepEqual(roots, ['/work/repoA', '/work/repoB']);
  clearObserved();
});

test('repoRootFromObserved 取最近写入的仓库，而不是最先写入的', async () => {
  clearObserved();
  const exists = async p => p === '/work/repoA/.git' || p === '/work/repoB/.git';
  recordWrite('mru', '/work/repoB/src/b.js');
  recordWrite('mru', '/work/repoA/src/a.js');
  // 先写 B 后写 A：旧实现（按插入序取第一个）会返回 repoB —— 审错树。
  assert.equal(await repoRootFromObserved('mru', { exists }), '/work/repoA');
  clearObserved();
});
