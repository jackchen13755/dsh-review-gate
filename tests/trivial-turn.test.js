/**
 * 运维回合免评审：只提交/推送/打 tag 的回合不触发评审。
 * 反例必须仍被评审（保守）：有写文件、bash 里改文件、出现未知工具。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyTurn } from '../lib/trivial-turn.js';
import { applyConfig } from '../lib/config.js';
import { handleTurnStopping, clearGateState, statusOf } from '../lib/gate.js';

const call = (name, turn, args) => ({ type: 'tool/call', data: { name, turn, arguments: JSON.stringify(args ?? {}) } });
const bash = (command, turn = 1) => call('bash', turn, { command });

test('纯运维回合（add/commit/push）判为 trivial', () => {
  const r = classifyTurn([bash('git add -A'), bash('git commit -m "x"'), bash('git push origin main')], { turn: 1 });
  assert.deepEqual(r, { trivial: true, reason: 'ops-only' });
});

test('运维 + 只读工具（read/lens/ledger）仍是 trivial', () => {
  const r = classifyTurn([call('read', 1, { file_path: '/a' }), call('ledger_evidence', 1, {}), bash('git status')], { turn: 1 });
  assert.equal(r.trivial, true);
});

test('有写文件工具 → 必须评审，且原因必须是 has-writes（钉住这条分支本身）', () => {
  for (const name of ['edit', 'write', 'multi_edit', 'apply_patch']) {
    const r = classifyTurn([call(name, 1, { file_path: '/a' })], { turn: 1 });
    assert.equal(r.trivial, false);
    assert.equal(r.reason, 'has-writes', `${name} 应走写文件分支，而不是被当成未知工具`);
  }
});

test('bash 里改文件（sed/tee/heredoc）→ 必须评审', () => {
  for (const command of ['sed -i s/a/b/ f.ts', 'cat > f.ts <<EOF\nx\nEOF', 'rm -f f.ts', 'npm install']) {
    assert.equal(classifyTurn([bash(command)], { turn: 1 }).trivial, false, command);
  }
});

test('未知工具 → 保守判为非运维（仍评审）', () => {
  assert.equal(classifyTurn([call('some_new_tool', 1, {})], { turn: 1 }).trivial, false);
});

test('只看本回合：别的回合的写文件不影响本回合判定', () => {
  const events = [call('edit', 5, { file_path: '/a' }), bash('git push', 6)];
  assert.equal(classifyTurn(events, { turn: 6 }).trivial, true);
});

test('没有工具调用 → 不判为运维（交给既有的 no-change 逻辑）', () => {
  assert.deepEqual(classifyTurn([], { turn: 1 }), { trivial: false, reason: 'no-tool-calls' });
});

test('边界输入：events 非数组 / 事件畸形不抛', () => {
  for (const bad of [undefined, null, 42, 'x', [null, {}, { type: 'tool/call' }]]) {
    assert.equal(classifyTurn(bad, {}).trivial, false);
  }
});

test('门禁层：提交推送回合即使 diff 命中配置类文件也放行，且不发起评审', async () => {
  clearGateState();
  applyConfig({ gate: true, autoReview: true, steer: false, gateMaxSteersPerTurn: 1, gateMaxSteersPerSession: 3, autoReviewTimeoutMs: 500 });
  const steered = [];
  let reviewed = false;
  const agent = {
    id: 'ops-turn',
    session: {
      header: { cwd: '/w/repo', delegationDepth: 0 },
      snapshotEvents: () => [bash('git commit -m "x"'), bash('git push')],
    },
    steer: (m) => steered.push(m),
  };
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    {
      liveCwd: () => '/w/repo',
      collectDiff: async () => ({ available: true, digest: 'O1', files: [{ path: 'package.json', status: 'M', added: ['x'], removed: [] }], totals: { added: 1, removed: 0 } }),
      readJournal: async () => ({ verdict: 'unknown' }),
      runCommand: async () => { reviewed = true; return { kind: 'success' }; },
    },
  );
  assert.equal(text, undefined);
  assert.equal(steered.length, 0);
  assert.equal(reviewed, false, '运维回合不应发起评审');
  assert.equal(statusOf('ops-turn').last.skipped, 'ops-only');
});

// ------------------------------------------------- 写意图与引号感知（2026-11-11）

/**
 * 这一组守的是**漏审**方向：真的改了工作树却判「免评审」。
 *
 * 为什么必须逐条列出来而不是抽查一个：早期实现把 echo/cat/ls/find/rg/sort
 * 一律当只读，6 种写法全部漏审，且用户完全看不出「这轮没审」。
 * 漏审比多审危险得多——多审只是浪费一次，漏审是静默放行。
 */
test('bash 带写意图 → 必须评审（重定向 / find 写操作 / xargs / sed -i / sort -o）', () => {
  const dangerous = [
    'echo hi > lib/a.js',
    'ls > /tmp/out.txt',
    'echo x >> lib/a.js',
    'find . -name x -exec sed -i s/a/b/ {} ;',
    'find . -delete',
    'rg foo | xargs sed -i s/a/b/',
    'sort -o out.txt in.txt',
    'cat a.js | tee b.js',
    'mv a.js b.js',
    'git status > /tmp/log.txt',
  ];
  for (const command of dangerous) {
    const r = classifyTurn([bash(command)], { turn: 1 });
    assert.equal(r.trivial, false, `必须评审：${command}`);
    assert.equal(r.reason, 'bash-write-intent', `原因要可区分：${command}`);
  }
});

/**
 * 这一组守的是**误审**方向：纯运维被判成要评审，白烧一次。
 * 用「引号内有分隔符 / 有 > / git 全局选项」三种最容易踩的写法。
 */
test('引号感知与 git 全局选项：纯运维仍判 trivial（不因分隔符/重定向字符误判）', () => {
  const safe = [
    'git commit -m "fix: a; b"',
    'git commit -m "note > file && done"',
    'git -C /repo commit -m x',
    'git -C /repo status',
    'git add -A && git commit -m x && git push origin main',
    'git log --oneline | head -5',
  ];
  for (const command of safe) {
    const r = classifyTurn([bash(command)], { turn: 1 });
    assert.equal(r.trivial, true, `应免评审：${command}（reason=${r.reason}）`);
  }
});

test('运维回合里出现真实写文件工具仍然优先判 has-writes（不被 bash 分支掩盖）', () => {
  const r = classifyTurn([bash('git status'), call('edit', 1, { file_path: '/a' })], { turn: 1 });
  assert.equal(r.trivial, false);
  assert.equal(r.reason, 'has-writes');
});

/**
 * 用户明确要求「合并无冲突时不用调评审」。
 *
 * 实现思路不是去猜 diff 内容，而是靠结构：无冲突的 merge 只有 git 调用 → 免评审；
 * 有冲突时必须 edit 冲突标记 → has-writes → 必评审。这两条一起钉住，缺一条就可能
 * 出现「有冲突也没审」（漏审漏在冲突解决这种最该审的地方）。
 */
test('无冲突合并：只有 git merge 调用 → 免评审', () => {
  for (const command of ['git merge feature', 'git merge --no-ff origin/main', 'git -C /repo merge topic']) {
    const r = classifyTurn([bash(command)], { turn: 1 });
    assert.equal(r.trivial, true, `应免评审：${command}（reason=${r.reason}）`);
  }
});

test('有冲突合并：一旦出现 edit 解决冲突 → 必须评审', () => {
  const r = classifyTurn([bash('git merge feature'), call('edit', 1, { file_path: 'a.ts' })], { turn: 1 });
  assert.equal(r.trivial, false);
  assert.equal(r.reason, 'has-writes');
});
