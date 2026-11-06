import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyConfig } from '../lib/config.js';
import { handleTurnStopping, clearGateState, statusOf } from '../lib/gate.js';
import { diag, diagPath } from '../lib/diag.js';
import { recordWrite } from '../lib/observed.js';

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
    gateSubagents: true,
    gateMaxSteersPerTurn: 1,
    gateMaxSteersPerSession: 3,
    canaryShadow: true,
  });
  clearGateState();
}

test('cwd 不是 git 仓库时，按反推的仓库根取证并照常推回评审', async () => {
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
  assert.deepEqual(seen, [NON_REPO, REPO_ROOT], '取证顺序必须是先 cwd、再仓库根');
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
