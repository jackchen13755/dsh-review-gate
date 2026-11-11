import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyConfig } from '../lib/config.js';
import { handleTurnStopping, clearGateState, statusOf } from '../lib/gate.js';
import { diag, diagPath } from '../lib/diag.js';
import { recordWrite, clearObserved } from '../lib/observed.js';
import { REPORT_SOURCE_KIND } from '../lib/review-report.js';

/**
 * 这组用例钉的是「改完代码为什么不自动评审」那个真故障：
 * 会话 cwd 不是 git 仓库（实测是多个插件仓库的父目录），git 取证必然失败，
 * 门禁于是静默放行。修法是按「本会话写过的文件」反推仓库根，再在那里取一次。
 */

function makeAgent({ id = 's1', depth = 0, events = [], cwd = '/tmp/not-a-repo' } = {}) {
  const steered = [];
  return {
    id,
    steered,
    session: { header: { cwd, delegationDepth: depth }, snapshotEvents: () => events },
    steer: (m) => steered.push(m),
  };
}

const configDiff = (digest = 'R1') => ({
  available: true,
  digest,
  files: [{ path: 'package.json', status: 'M', added: ['  "x": 1'], removed: [] }],
  totals: { added: 1, removed: 0 },
});

const NON_REPO = '/tmp/not-a-repo';
const REPO_ROOT = '/tmp/plugin-repo';

function reset() {
  applyConfig({
    gate: true,
    gateMaxSteersPerTurn: 1,
    gateMaxSteersPerSession: 3,
    canaryShadow: true,
  });
  clearGateState();
}

test('cwd 不是 git 仓库时，直接按写入根取证并照常推回评审', async () => {
  reset();
  const seen = [];
  const deps = {
    // cwd 取不到（真实场景就是 not a git repository），仓库根取得到
    collectDiff: async (dir) => {
      seen.push(dir);
      return dir === REPO_ROOT ? configDiff('R1') : { available: false, reason: 'not a git repository' };
    },
    repoRoot: async () => REPO_ROOT,
    readJournal: async () => ({ verdict: 'unknown' }),
  };
  const agent = makeAgent({ id: 'root-fallback', cwd: NON_REPO });
  const text = await handleTurnStopping({ agent, turn: 1 }, deps);

  assert.ok(text, '反推仓库根之后应当照常推回评审（这正是用户反馈失效的那一步）');
  assert.equal(agent.steered.length, 1);
  // 2026-11-10 契约变更：范围改由「写过的文件」反推，直接取写入根，
  // 不再先跑一次必然失败的 cwd（那也是「worktree 里改、评审看主区域」的根源）。
  assert.deepEqual(seen, [REPO_ROOT], '直接按写入根取证');
  assert.deepEqual(statusOf('root-fallback').last.reasons, ['config']);
});

test('反推不出仓库根时不硬造 diff，仍然如实记 no-diff', async () => {
  reset();
  const deps = {
    collectDiff: async () => ({ available: false, reason: 'not a git repository' }),
    repoRoot: async () => undefined,
    readJournal: async () => ({ verdict: 'unknown' }),
  };
  const agent = makeAgent({ id: 'root-missing', cwd: NON_REPO });
  const text = await handleTurnStopping({ agent, turn: 1 }, deps);

  assert.equal(text, undefined, '拿不到证据就不能拦');
  assert.equal(agent.steered.length, 0);
  assert.equal(statusOf('root-missing').last.skipped, 'no-diff');
  assert.equal(statusOf('root-missing').last.detail, 'not a git repository', '原因要留在状态里，别只说「没改动」');
});

test('仓库根与 cwd 相同就不重复取证（省一次 git 调用）', async () => {
  reset();
  const seen = [];
  const deps = {
    collectDiff: async (dir) => {
      seen.push(dir);
      return { available: false, reason: 'not a git repository' };
    },
    repoRoot: async () => NON_REPO,
    readJournal: async () => ({ verdict: 'unknown' }),
  };
  const agent = makeAgent({ id: 'root-same', cwd: NON_REPO });
  await handleTurnStopping({ agent, turn: 1 }, deps);
  assert.deepEqual(seen, [NON_REPO], '根与 cwd 相同时不该再取一次');
});

test('测试期不往生产日志写字（否则实机日志没法用来判断）', () => {
  // 用临时路径验证，绝不碰真实日志：早先版本直接读生产日志断言「尾部没有探针」，
  // 结果变异测试把探针真写进去了，用例从此恒红——断言不能依赖会变的历史。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-'));
  const tmpFile = path.join(dir, 'gate.log');
  const prevFile = process.env.DSH_REVIEW_GATE_DIAG_FILE;
  process.env.DSH_REVIEW_GATE_DIAG_FILE = tmpFile;
  try {
    diag('PROBE-SHOULD-NOT-WRITE');
    assert.equal(fs.existsSync(tmpFile), false, '测试期 diag 必须静默');

    process.env.DSH_REVIEW_GATE_DIAG_FORCE = '1';
    diag('PROBE-FORCED');
    const text = fs.readFileSync(tmpFile, 'utf8');
    assert.match(text, /PROBE-FORCED/, '显式打开 force 后应当写，否则「静默」就成了「永不写」');
    assert.equal(text.includes('PROBE-SHOULD-NOT-WRITE'), false, 'force 之前那次不该被补写进来');
  } finally {
    delete process.env.DSH_REVIEW_GATE_DIAG_FORCE;
    if (prevFile === undefined) delete process.env.DSH_REVIEW_GATE_DIAG_FILE;
    else process.env.DSH_REVIEW_GATE_DIAG_FILE = prevFile;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('观察记录能把仓库根推出来（真实场景的输入）', async () => {
  // 造一个真仓库：<tmp>/repo/.git + <tmp>/repo/src/a.js
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-root-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'const a = 1;\n');

  recordWrite('obs-side', path.join(repo, 'src', 'a.js'));
  const { repoRootFromObserved } = await import('../lib/observed.js');
  assert.equal(await repoRootFromObserved('obs-side'), repo, '应当从写过的文件往上找到含 .git 的目录');
  fs.rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------- diffRoot：这份 diff 到底属于哪棵树

/**
 * 为什么要钉 diffRoot（2026-11-11）：
 * `reviewedDigest` / `reviewBasis` 的键是 `(session, root)`，root 取的是 **diff 实际来自的那棵树**
 * （diffRoot），而不是判定开始时算出的范围根（scope.root）。两条回落取证路径都会换树：
 *   · 主范围取不到 diff → 回落到反推的仓库根；
 *   · git 完全不可用 → 退化成本会话观察快照（其 path 相对 cwd）。
 * 换了树却还按旧根记键，就会把「这棵树审过的摘要」记成另一棵树的 —— 于是内容相同的改动
 * 在别的仓库里被判「已评审」而一个字没审（false pass），比串范围更严重。
 * 这两条 key 过去没有任何用例断言过（删掉 diffRoot 赋值，全套仍然绿），所以补在这里。
 */
const reportEvent = (text) => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text }], source: { kind: REPORT_SOURCE_KIND } },
});
/** 一条「评审已完成」的报告：让这一轮真的走到「已评审」，从而写下 reviewedDigest。 */
const completedReport = () => reportEvent('Here is the completed code review report: ok');

/** statusOf 里 reviewedDigests 的 root 列表（键本身是 (session,root)，值里带拆好的 root）。 */
const digestedRoots = (sid) => Object.values(statusOf(sid).reviewedDigests).map((e) => e.root);

test('回落②：git 不可用 → 退化成会话观察快照时，diffRoot 必须记成会话目录（快照 path 相对 cwd）', async () => {
  reset();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'degrade-root-'));
  const repo = path.join(base, 'repo');
  const cwd = path.join(repo, 'packages', 'app');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), '{\n  "name": "x"\n}\n');

  const sid = 'degrade-diffroot';
  clearObserved(sid);
  // 会话在 cwd 里改了配置类文件 → 反推的仓库根是外层 repo，与 cwd 不是同一棵
  recordWrite(sid, path.join(cwd, 'package.json'));

  const deps = {
    // git 在这台机器/这棵树上不可用（超时、索引坏、被锁）：两条 git 路径都拿不到 diff
    collectDiff: async () => ({ available: false, reason: 'not a git work tree' }),
    gitRoot: async () => repo,
    readJournal: async () => ({ verdict: 'unknown' }),
  };
  const agent = makeAgent({ id: sid, cwd, events: [completedReport()] });
  const text = await handleTurnStopping({ agent, turn: 1 }, deps);

  const st = statusOf(sid);
  assert.equal(text, undefined, '已评审的回合不该再被推回');
  assert.equal(st.last?.reviewed, true, '前置：这一轮必须真的走到「已评审」，否则读不到 reviewedDigests');
  assert.match(String(st.last?.digest ?? ''), /^[0-9a-f]{64}$/, '前置：已评审这一轮会记下摘要');
  assert.deepEqual(
    digestedRoots(sid),
    [cwd],
    '降级快照的路径是相对 cwd 的 → 这份 diff 属于 cwd 这棵树；记成仓库根就会让「外层仓库里同样内容的改动」被误判已评审',
  );
  fs.rmSync(base, { recursive: true, force: true });
});

test('回落①：主范围取不到 diff、改用反推的仓库根取证时，diffRoot 必须换成那棵树（不串仓）', async () => {
  reset();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-root-'));
  const cwd = path.join(base, 'work');
  const scopeRoot = path.join(base, 'scope-a'); // 主范围：这棵树取不到 diff
  const retryRoot = path.join(base, 'repo-b'); // 反推出的仓库根：能取到 diff
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(scopeRoot, { recursive: true });
  fs.mkdirSync(path.join(retryRoot, '.git'), { recursive: true });
  fs.mkdirSync(path.join(retryRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(retryRoot, 'src', 'a.js'), 'const a = 1;\n');

  const sid = 'retry-diffroot';
  clearObserved(sid);
  // 观察记录落在 repo-b 里 → 拿不到 deps.repoRoot 时，回落重试会自己反推出 repo-b
  recordWrite(sid, path.join(retryRoot, 'src', 'a.js'));

  const seen = [];
  let collectRoot; // 第 2 轮让主范围也能取到 diff（用来验「换 root 不串仓」）
  const deps = {
    collectDiff: async (dir) => {
      seen.push(dir);
      if (dir === retryRoot) return configDiff('R2');
      if (dir === scopeRoot && collectRoot === scopeRoot) return configDiff('R2');
      return { available: false, reason: 'not a git work tree' };
    },
    // 主范围来自宿主给的范围列表（列表头那棵树取不到 diff），
    // 而回落重试走的是反推路径 —— 两者在这一轮给出的是不同的树。
    repoRoots: async () => [scopeRoot],
    gitRoot: async () => undefined,
    readJournal: async () => ({ verdict: 'unknown' }),
  };

  const agent1 = makeAgent({ id: sid, cwd, events: [completedReport()] });
  await handleTurnStopping({ agent: agent1, turn: 1 }, deps);

  assert.deepEqual(seen, [scopeRoot, retryRoot], '前置：必须先取主范围，再回落到反推的仓库根');
  assert.deepEqual(
    digestedRoots(sid),
    [retryRoot],
    'diff 是从 retryRoot 取到的 → 必须按这棵树记键，否则 B 仓审过的摘要会放行 A 仓同样内容的改动',
  );

  // 第 2 轮：主范围这次取到了**内容完全相同**的 diff。键若还挂在 retryRoot 上，
  // 这里就会因为「(session,A) 没有记录」而正确要求评审；反过来（第 1 轮记成 scopeRoot）
  // 就会静默放行 —— 一个字都没审。
  collectRoot = scopeRoot;
  const agent2 = makeAgent({ id: sid, cwd, events: [] });
  await handleTurnStopping({ agent: agent2, turn: 2 }, deps);
  assert.equal(
    statusOf(sid).last?.needsAgentReview,
    true,
    '主范围换回来是另一棵树 → 同 digest 也不能算「已评审」（这正是 diffRoot 记错时会犯的假放行）',
  );
  fs.rmSync(base, { recursive: true, force: true });
});
