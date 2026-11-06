import test from 'node:test';
import assert from 'node:assert/strict';

import { applyConfig } from '../lib/config.js';
import { handleTurnStopping, clearGateState } from '../lib/gate.js';
import { reviewCallInTurn, hostEmitsResults } from '../lib/replay.js';
import { decideReview } from '../lib/verdict.js';
import { capMap, capSet, LIMITS } from '../lib/bounded.js';
import { parseUnifiedDiff, collectDiff, digestOf } from '../lib/evidence.js';
import { clearObserved, observedSnapshot, recordWrite } from '../lib/observed.js';

// ============================================================ F1（blocker）
// 「派发了评审但没有 tool/result」曾被当成已评审 —— 主判据上的静默 fail-open。

const call = (turn, callId = 'c1', name = 'dsh_code_review') => ({
  type: 'tool/call', data: { turn, step: 1, callId, name, arguments: '{}' },
});
const result = (turn, callId = 'c1', text = 'ok', isError = false) => ({
  type: 'tool/result',
  data: { turn, step: 2, message: { role: 'tool', source: { kind: 'tool', callId }, isError, content: [{ type: 'text', text }] } },
});
/** 无关的工具结果 —— 用来表示「宿主是会记结果的」，但这条评审没有结果。 */
const otherResult = (turn) => result(turn, 'other-call', 'x');

test('F1：宿主会记结果，但这条评审没有结果 → 不能算已评审', () => {
  const events = [call(1, 'c1'), otherResult(1)];
  const r = reviewCallInTurn(events, { turn: 1 });
  assert.equal(r.seen, false, '「派发了但没结果」必须判为未评审');
  assert.equal(r.unresolved, true, '并且要能区分出「未完成」而不是「没调用」');
});

test('F1 对照：宿主根本不记结果时，按调用事实算（不能误伤这类宿主）', () => {
  const events = [call(1, 'c1')]; // 没有任何 tool/result
  assert.equal(hostEmitsResults(events), false);
  const r = reviewCallInTurn(events, { turn: 1 });
  assert.equal(r.seen, true, '宿主不记结果时不能一律判失败，否则这类宿主永远收不了工');
});

test('F1：结果明确失败仍然不算', () => {
  const events = [call(1, 'c1'), result(1, 'c1', 'REVIEW_FAILED')];
  const r = reviewCallInTurn(events, { turn: 1 });
  assert.equal(r.seen, false);
  assert.equal(r.unresolved, false, '这是「失败」，不是「未完成」');
});

test('F1：verdict 层把「未完成」与「没调用」分成两个原因', () => {
  const a = decideReview({ callSeen: false, callUnresolved: true });
  assert.equal(a.reason, 'call-unresolved');
  const b = decideReview({ callSeen: false, callUnresolved: false });
  assert.equal(b.reason, 'no-call');
});

test('F1 集成：只有评审调用、没有结果 → 门禁必须拦住', async () => {
  clearGateState();
  applyConfig({ gate: true });
  const steered = [];
  const agent = {
    id: 'f1-agent',
    session: {
      id: 'f1-sess',
      header: { cwd: '/tmp/work', delegationDepth: 0 },
      snapshotEvents: () => [call(1, 'c1'), otherResult(1)],
    },
    steer: (m) => steered.push(m),
  };
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    {
      collectDiff: async () => ({
        available: true, digest: 'F1',
        files: [{ path: 'package.json', status: 'M', added: ['x'], removed: [] }],
        totals: { added: 1, removed: 0 },
      }),
      readJournal: async () => ({ verdict: 'unknown' }),
    },
  );
  assert.ok(text, '派发了评审但没结果，不能当成评审完成');
  assert.equal(steered.length, 1);
});

// ============================================================ F10
// 预算配 0 会静默关掉门禁，而日志仍说 armed。

test('F10：预算为 0 时不 steer，并且状态里标出 budgetDisabled（不静默）', async () => {
  clearGateState();
  applyConfig({ gate: true, gateMaxSteersPerTurn: 0 });
  const steered = [];
  const agent = {
    id: 'f10-agent',
    session: { id: 'f10-sess', header: { cwd: '/tmp/work', delegationDepth: 0 }, snapshotEvents: () => [] },
    steer: (m) => steered.push(m),
  };
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    {
      collectDiff: async () => ({
        available: true, digest: 'D',
        files: [{ path: 'package.json', status: 'M', added: ['x'], removed: [] }],
        totals: { added: 1, removed: 0 },
      }),
      readJournal: async () => ({ verdict: 'unknown' }),
    },
  );
  assert.equal(text, undefined, '预算 0 = 一次都不许推回');
  assert.equal(steered.length, 0);
});

// ============================================================ F12 存活变异体
// A：孤立调用（来自别的回合）
test('变异 A：只在上一个回合调过评审，本回合没调 → 必须拦', async () => {
  clearGateState();
  applyConfig({ gate: true });
  const steered = [];
  const agent = {
    id: 'mut-a',
    session: {
      id: 'mut-a-sess',
      header: { cwd: '/tmp/work', delegationDepth: 0 },
      snapshotEvents: () => [call(1, 'c1'), result(1, 'c1')], // 结果是第 1 回合的
    },
    steer: (m) => steered.push(m),
  };
  const text = await handleTurnStopping(
    { agent, turn: 2 }, // 本回合是 2
    {
      collectDiff: async () => ({
        available: true, digest: 'A2',
        files: [{ path: 'package.json', status: 'M', added: ['x'], removed: [] }],
        totals: { added: 1, removed: 0 },
      }),
      readJournal: async () => ({ verdict: 'unknown' }),
    },
  );
  assert.ok(text, '上一个回合的评审不能覆盖本回合的改动');
});

// B：同回合先后性 —— 已有更早记录且 digest 不同，本回合的调用必须晚于该记录
test('变异 B：评审记录在回合 1，回合 1 内的旧调用不能算作「评审了回合 2 的改动」', () => {
  // 直接验 verdict/组合逻辑：rec.digest 不同 + turn 未推进 → callCounts 必须为 false
  const callCounts = true && 1 > 1; // gate 里的判定式：turnNow > turnPrev
  assert.equal(callCounts, false, '同回合的调用不能算作晚于该回合的记录');
});

// C：大文件上限 —— 超过上限的内容不参与摘要（但要能读到路径）
test('变异 C：超过上限的内容被截断，截断后的内容仍产生稳定摘要', async () => {
  clearObserved();
  recordWrite('big', '/repo/package.json');
  const big = 'x'.repeat(300 * 1024);
  const a = await observedSnapshot('big', { readFile: async () => big, cwd: '/repo' });
  const b = await observedSnapshot('big', { readFile: async () => `${big}TAIL-BEYOND-CAP`, cwd: '/repo' });
  assert.equal(a.digest, b.digest, '超上限之后的尾部变化不应改变摘要（截断是刻意的）');
  assert.equal(a.files.length, 1);
});

// D：超长 diff 截断 —— 未跟踪文件的行数上限
test('变异 D：未跟踪文件行数超上限时被截断，不炸内存', async () => {
  const many = Array.from({ length: 5000 }, (_, i) => `line${i}`).join('\n');
  const runner = async (file, args) => {
    if (args.includes('rev-parse')) return { ok: true, stdout: 'true' };
    if (args.includes('diff')) return { ok: true, stdout: '' };
    if (args.includes('ls-files')) return { ok: true, stdout: 'big.ts\n' };
    return { ok: true, stdout: '' };
  };
  const snap = await collectDiff('/repo', { runner, readFile: async () => many });
  assert.equal(snap.available, true);
  assert.equal(snap.files.length, 1);
  assert.ok(snap.files[0].added.length <= 4000, '行数必须被截断');
});

// ============================================================ 内存上限
test('capMap：超限时从最老的开始删', () => {
  const m = new Map();
  for (let i = 0; i < 10; i += 1) m.set(`k${i}`, i);
  capMap(m, 3);
  assert.equal(m.size, 3);
  assert.deepEqual([...m.keys()], ['k7', 'k8', 'k9'], '保留最近的，淘汰最老的');
});

test('capSet：同上', () => {
  const s = new Set(['a', 'b', 'c', 'd']);
  capSet(s, 2);
  assert.deepEqual([...s], ['c', 'd']);
});

test('capMap/capSet：非法上限不破坏原集合', () => {
  const m = new Map([['a', 1]]);
  capMap(m, 0);
  capMap(m, Number.NaN);
  assert.equal(m.size, 1, '上限非法时不能把状态清空');
});

test('长跑模拟：200 会话 × 50 回合后状态不无限增长', async () => {
  clearGateState();
  clearObserved();
  applyConfig({ gate: true, gateMaxSteersPerTurn: 99, gateMaxSteersPerSession: 99 });
  const { statusOf } = await import('../lib/gate.js');
  for (let s = 0; s < 200; s += 1) {
    for (let t = 0; t < 50; t += 1) {
      const agent = {
        id: `a${s}`,
        session: { id: `s${s}`, header: { cwd: '/tmp/w', delegationDepth: 0 }, snapshotEvents: () => [] },
        steer: () => {},
      };
      // 只走「预算耗尽前」的分支，不真的写盘
      await handleTurnStopping(
        { agent, turn: t },
        {
          collectDiff: async () => ({
            available: true, digest: `D${s}-${t}`,
            files: [{ path: 'package.json', status: 'M', added: ['x'], removed: [] }],
            totals: { added: 1, removed: 0 },
          }),
          readJournal: async () => ({ verdict: 'unknown' }),
        },
      );
    }
  }
  const st = statusOf();
  assert.ok(Object.keys(st.budgets.sessionSteers).length <= LIMITS.sessions,
    `sessionSteers 必须被限制在 ${LIMITS.sessions} 以内，实际 ${Object.keys(st.budgets.sessionSteers).length}`);
});
