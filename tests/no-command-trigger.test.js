/**
 * 2026-11-11 契约变更：门禁**不再**替模型执行 /review。
 *
 * 用户决定：`dsh_code_review` 已恢复为模型可调用工具，所以删掉门禁那条命令触发路径。
 * 原因是两条触发路径会互相叠加 —— 门禁代跑一次 → 报告回投 → 模型照提示再调一次工具
 * → 门禁又判定「需评审」→ 再代跑……实测出现无限评审（主 agent 收到结果后不修复，
 * 直接又触发评审）。
 *
 * 现在唯一的发起方是模型自己（或用户敲 /review）。门禁的职责只剩：判定、记录、
 * 在需要时把「该评审了」明确写进状态里（可观测，但不代劳）。
 *
 * 所以这一组用例的核心断言是**反向**的：无论输入怎么构造，runCommand 都不得被调用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { applyConfig } from '../lib/config.js';
import { handleTurnStopping, clearGateState, statusOf } from '../lib/gate.js';
import { recordWrite, clearObserved } from '../lib/observed.js';

function makeAgent({ id = 's1', events = [], cwd = '/tmp/work' } = {}) {
  const steered = [];
  return {
    id,
    steered,
    session: { header: { cwd, delegationDepth: 0 }, snapshotEvents: () => events },
    steer: (m) => steered.push(m),
  };
}

const configDiff = (digest = 'A1', files) => ({
  available: true,
  digest,
  files: files ?? [{ path: 'package.json', status: 'M', added: ['  "x": 1'], removed: [] }],
  totals: { added: 1, removed: 0 },
});

const journalUnknown = async () => ({ verdict: 'unknown' });

function setup(overrides = {}) {
  clearGateState();
  clearObserved();
  applyConfig({ gate: true, gateMaxSteersPerTurn: 1, gateMaxSteersPerSession: 3, steer: false, ...overrides });
}

/** 一个会记录「是否被执行」的 runCommand：新契约下它必须永远拿到 0 次调用。 */
function spyRunner() {
  const lines = [];
  return { lines, runCommand: async (line) => { lines.push(line); return { kind: 'success' }; } };
}

test('需要评审时不执行任何命令（无限循环的根因已移除）', async () => {
  setup();
  const spy = spyRunner();
  await handleTurnStopping({ agent: makeAgent(), turn: 1 }, {
    collectDiff: async () => configDiff(),
    readJournal: journalUnknown,
    runCommand: spy.runCommand,
  });
  assert.deepEqual(spy.lines, [], '门禁不得再代跑 /review');
  const last = statusOf('s1').last;
  assert.equal(last.needsAgentReview, true, '必须明确记录「该由 agent 评审」');
  assert.match(last.hint, /dsh_code_review/, '提示要指向真正的入口');
});

test('即使传入旧配置 autoReview=true 也不执行命令（开关已无执行路径）', async () => {
  setup({ autoReview: true, autoReviewInput: '审查未提交的更改' });
  const spy = spyRunner();
  await handleTurnStopping({ agent: makeAgent(), turn: 1 }, {
    collectDiff: async () => configDiff(),
    readJournal: journalUnknown,
    runCommand: spy.runCommand,
  });
  assert.deepEqual(spy.lines, []);
});

test('多回合反复收尾：每一回合都不执行命令（不会自激）', async () => {
  setup();
  const spy = spyRunner();
  const deps = { collectDiff: async () => configDiff('SAME'), readJournal: journalUnknown, runCommand: spy.runCommand };
  for (let turn = 1; turn <= 5; turn += 1) {
    await handleTurnStopping({ agent: makeAgent(), turn }, deps);
  }
  assert.deepEqual(spy.lines, [], '连续 5 回合都不该代跑');
});

test('没有 runCommand 也不崩（新契约下它根本不该被需要）', async () => {
  setup();
  const out = await handleTurnStopping({ agent: makeAgent(), turn: 1 }, {
    collectDiff: async () => configDiff(),
    readJournal: journalUnknown,
  });
  assert.equal(out, undefined);
  assert.equal(statusOf('s1').last.needsAgentReview, true);
});

test('跨仓库会话：报出全部仓库根，主范围取最近写入的那个', async () => {
  setup();
  const roots = ['/work/repoA', '/work/repoB'];
  await handleTurnStopping({ agent: makeAgent(), turn: 1 }, {
    collectDiff: async () => configDiff('R1'),
    readJournal: journalUnknown,
    repoRoots: async () => roots,
    gitRoot: async () => '/work',
  });
  const st = statusOf('s1');
  assert.deepEqual(st.repos, roots);
  assert.equal(st.spanning, true, '跨仓库必须显式标记');
  assert.equal(st.last.reviewRoot, '/work/repoA', '主范围必须是 repos[0]');
});

test('同树两会话各自独立记账（不互相顶账）', async () => {
  setup();
  const reportEvents = [{ type: 'user/message', data: {
    content: [{ type: 'text', text: 'Here is the completed code review report:\n\nok' }],
    source: { kind: 'michengai-code-review' },
  } }];
  const deps = {
    collectDiff: async () => configDiff('SAME-TREE'),
    readJournal: journalUnknown,
    repoRoots: async () => ['/work/repoA'],
    gitRoot: async () => '/work/repoA',
  };
  await handleTurnStopping({ agent: makeAgent({ id: 'sA' }), turn: 1 }, deps);
  await handleTurnStopping({ agent: makeAgent({ id: 'sA', events: reportEvents }), turn: 1 }, deps);
  const b = statusOf('sB');
  assert.equal(b.last, null, 'B 不能继承 A 的评审记录');
  await handleTurnStopping({ agent: makeAgent({ id: 'sB' }), turn: 1 }, deps);
  assert.equal(statusOf('sB').last.needsAgentReview, true, 'B 必须自己走一次判定');
});

test('只评审本会话自己的改动：别的会话改的文件被排除并记录', async () => {
  setup();
  recordWrite('mine', '/work/repoA/src/mine.ts');
  await handleTurnStopping({ agent: makeAgent({ id: 'mine' }), turn: 1 }, {
    collectDiff: async () => configDiff('T', [
      { path: 'src/mine.ts', status: 'M', added: ['+'], removed: ['-'] },
      { path: 'src/other-session.ts', status: 'M', added: ['+'], removed: ['-'] },
    ]),
    readJournal: journalUnknown,
    repoRoots: async () => ['/work/repoA'],
    gitRoot: async () => '/work/repoA',
  });
  assert.deepEqual(statusOf('mine').excludedFiles, ['src/other-session.ts']);
  assert.equal(statusOf('mine').last.needsAgentReview, true);
});

test('改动全部属于别的会话 → 明确跳过，不能记成「确认无改动」', async () => {
  setup();
  recordWrite('mine', '/work/repoA/src/mine.ts');
  await handleTurnStopping({ agent: makeAgent({ id: 'mine' }), turn: 1 }, {
    collectDiff: async () => configDiff('T', [
      { path: 'src/other-session.ts', status: 'M', added: ['+'], removed: ['-'] },
    ]),
    readJournal: journalUnknown,
    repoRoots: async () => ['/work/repoA'],
    gitRoot: async () => '/work/repoA',
  });
  const last = statusOf('mine').last;
  assert.equal(last.skipped, 'other-session-only');
  assert.equal(last.noChange, false);
});

test('没有写入记录时不收敛（仍按整棵树判，避免静默漏审）', async () => {
  setup();
  await handleTurnStopping({ agent: makeAgent({ id: 'norec' }), turn: 1 }, {
    collectDiff: async () => configDiff('T', [
      { path: 'src/a.ts', status: 'M', added: ['+'], removed: ['-'] },
    ]),
    readJournal: journalUnknown,
    repoRoots: async () => ['/work/repoA'],
    gitRoot: async () => '/work/repoA',
  });
  assert.deepEqual(statusOf('norec').excludedFiles, [], '无法归属时不该声称排除了任何文件');
  assert.equal(statusOf('norec').last.needsAgentReview, true);
});
