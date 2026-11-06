import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { classifyTrigger, isCommentOnly, REASONS } from '../lib/trigger.js';
import { applyConfig } from '../lib/config.js';
import { handleTurnStopping, clearGateState, statusOf } from '../lib/gate.js';

/**
 * 评审反馈的三条边界（2026-11-06）。前两条真 bug，第三条是「有意设计但注释在说谎」。
 */

const f = (p, added = [], removed = []) => ({ path: p, added, removed, status: 'M' });
const snap = (files) => ({
  available: true,
  files,
  totals: files.reduce(
    (a, x) => ({ added: a.added + (x.added?.length ?? 0), removed: a.removed + (x.removed?.length ?? 0) }),
    { added: 0, removed: 0 },
  ),
});

test('JS 的 #privateField 是代码，不许被判成「纯注释」静默放行', () => {
  const fieldLine = f('src/cache.js', ['  #cache = new Map();']);
  // 一刀切把 # 当注释时：isCommentOnly=true → 还会把已命中的 decision 一并删掉 → 不触发
  assert.equal(isCommentOnly([fieldLine]), false, '# 在 .js 里是私有字段，不是注释');
  const r = classifyTrigger(snap([fieldLine]));
  assert.ok(r.trigger, `JS 私有字段改动必须触发，实际 reasons=${JSON.stringify(r.reasons)}`);

  // 中性私有字段行：不该命中任何具体规则，必须由兜底 code 接住
  const neutral = snap([f('src/cache.js', ['  #ready = false;'])]);
  const r2 = classifyTrigger(neutral);
  assert.ok(r2.trigger, `中性私有字段改动也必须触发，实际 reasons=${JSON.stringify(r2.reasons)}`);
  assert.ok(r2.reasons.includes(REASONS.CODE), `应当由兜底 code 接住，实际 ${JSON.stringify(r2.reasons)}`);
});

test('CSS 的 #id 选择器是代码', () => {
  const r = classifyTrigger(snap([f('src/app.css', ['#main { color: red; }'])]));
  assert.ok(r.trigger, `#id 选择器改动必须触发，实际 reasons=${JSON.stringify(r.reasons)}`);
});

test('.py / .sh 里的 # 仍然是注释，纯注释改动放行', () => {
  assert.equal(isCommentOnly([f('src/a.py', ['# 这只是注释'])]), true);
  assert.equal(isCommentOnly([f('ci/build.sh', ['# 换个说法'])]), true);
  const r = classifyTrigger(snap([f('src/a.py', ['# 这只是注释'])]));
  assert.equal(r.trigger, false, `纯注释不该被拦，实际 ${JSON.stringify(r.reasons)}`);
});

test('.js 里的 // 注释仍然放行（别把真注释也变成噪声）', () => {
  assert.equal(isCommentOnly([f('src/a.js', ['// 说明一下'])]), true);
  assert.equal(isCommentOnly([f('src/a.js', ['/* 块注释 */'])]), true);
});

// ---------------------------------------------------------------- 预算耗尽要可见

function makeAgent(id, cwd = '/tmp/nowhere') {
  const steered = [];
  return {
    id,
    steered,
    session: { header: { cwd, delegationDepth: 0 }, snapshotEvents: () => [] },
    steer: (m) => steered.push(m),
  };
}

const cfgDiff = (digest = 'B1') => ({
  available: true,
  digest,
  files: [{ path: 'src/a.js', status: 'M', added: ['const x = 1;'], removed: [] }],
  totals: { added: 1, removed: 0 },
});

test('预算耗尽不再静默：状态里要能回答「为什么这次没评审」，日志也要留痕', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-'));
  const logFile = path.join(dir, 'gate.log');
  const prevFile = process.env.DSH_REVIEW_GATE_DIAG_FILE;
  const prevForce = process.env.DSH_REVIEW_GATE_DIAG_FORCE;
  process.env.DSH_REVIEW_GATE_DIAG_FILE = logFile;
  process.env.DSH_REVIEW_GATE_DIAG_FORCE = '1'; // 测试期默认静默，这条要验它真写了

  try {
    applyConfig({ gate: true, gateMaxSteersPerTurn: 1, gateMaxSteersPerSession: 1, reviewAnyCodeChange: true });
    clearGateState();

    const agent = makeAgent('budget-sid');
    const deps = { collectDiff: async () => cfgDiff('B1'), readJournal: async () => ({ verdict: 'unknown' }) };

    await handleTurnStopping({ agent, turn: 1 }, deps); // 第一次：正常催办
    assert.equal(agent.steered.length, 1);
    await handleTurnStopping({ agent, turn: 2 }, deps); // 第二次：会话额度已尽

    const st = statusOf('budget-sid').last;
    assert.equal(st.admittedByBudget, true, '耗预算时仍要放行（不能让会话卡死）');
    assert.equal(st.reason, 'budget-exhausted', `状态里必须能看出是预算耗尽，实际 ${JSON.stringify(st)}`);
    assert.ok(st.budget && st.budget.which, '要说明是哪个预算耗尽');
    assert.match(fs.readFileSync(logFile, 'utf8'), /预算耗尽/, '实机日志里必须留痕，不能只在 debug 通道');
  } finally {
    if (prevFile === undefined) delete process.env.DSH_REVIEW_GATE_DIAG_FILE;
    else process.env.DSH_REVIEW_GATE_DIAG_FILE = prevFile;
    if (prevForce === undefined) delete process.env.DSH_REVIEW_GATE_DIAG_FORCE;
    else process.env.DSH_REVIEW_GATE_DIAG_FORCE = prevForce;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('预算按检查点分桶是既有设计（pre-step 有独立额度），改动前要先看这条', async () => {
  // 这条不是「验功能」，是把一个容易被误判成 bug 的设计选择钉住：
  // sessionKey 含 budgetKey，所以 turn-stopping 与 pre-step 各有一份额度。
  // 评审曾把它当缺陷报上来——改掉它会破坏 pre-step 的独立额度（见 prestep.test.js）。
  applyConfig({ gate: true, gateMaxSteersPerTurn: 1, gateMaxSteersPerSession: 1, reviewAnyCodeChange: true });
  clearGateState();
  const agent = makeAgent('bucket-sid');
  const deps = (budgetKey) => ({
    collectDiff: async () => cfgDiff('B1'),
    readJournal: async () => ({ verdict: 'unknown' }),
    budgetKey,
  });

  await handleTurnStopping({ agent, turn: 1 }, deps('turn'));       // turn 桶用掉
  await handleTurnStopping({ agent, turn: 1 }, deps('turn'));       // turn 桶耗尽
  const beforePreStep = agent.steered.length;
  await handleTurnStopping({ agent, turn: 1 }, deps('pre-step'));   // pre-step 桶仍有额度
  assert.equal(
    agent.steered.length,
    beforePreStep + 1,
    'pre-step 应当有独立额度（这是有意的设计，不是 bug）',
  );
});
