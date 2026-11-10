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
