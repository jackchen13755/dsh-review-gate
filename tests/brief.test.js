import test from 'node:test';
import assert from 'node:assert/strict';

import { renderBrief, checklistFor } from '../lib/brief.js';
import { applyConfig } from '../lib/config.js';
import { handleTurnStopping, clearGateState } from '../lib/gate.js';

// ---------------------------------------------------------------- 简报渲染

test('拿不到 diff 时：必须明说，不能让调用者以为评审过了', () => {
  const text = renderBrief({ available: false, reason: 'not a git work tree' });
  assert.match(text, /拿不到改动/);
  assert.match(text, /not a git work tree/);
  assert.match(text, /不要当作已完成评审/);
});

test('工作区干净：明说无需评审', () => {
  const text = renderBrief({ available: true, files: [], totals: { added: 0, removed: 0 } });
  assert.match(text, /没有未提交改动/);
});

test('有改动：包含文件清单、规模、触发原因与清单', () => {
  const text = renderBrief(
    {
      available: true,
      files: [{ path: 'lib/a.js', status: 'M', added: ['const x = 1'], removed: [] }],
      totals: { added: 1, removed: 0 },
    },
    { reasons: ['config'], note: '重点看边界' },
  );
  assert.match(text, /lib\/a\.js/);
  assert.match(text, /\+1 \/ -0/);
  assert.match(text, /config/);
  assert.match(text, /重点看边界/);
  assert.match(text, /审查由你（调用者）完成/, '必须明确「不 spawn 子 Agent」，不能让调用者误解为独立评审');
});

test('清单随触发原因变化（不是固定模板）', () => {
  const structural = checklistFor(['structural']).join('\n');
  const security = checklistFor(['security']).join('\n');
  assert.match(structural, /模块边界/);
  assert.match(security, /安全/);
  assert.notEqual(structural, security, '不同触发原因必须给不同清单');
});

test('清单任何时候都含两条万金油：边界输入 与 验证载体', () => {
  const text = checklistFor([]).join('\n');
  assert.match(text, /边界输入/);
  assert.match(text, /验证载体/);
});

test('超长改动会被截断，不撑爆上下文', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ path: `f${i}.js`, status: 'M', added: ['x'], removed: [] }));
  const text = renderBrief({ available: true, files: many, totals: { added: 200, removed: 0 } });
  assert.ok(text.length <= 50 * 1024, `简报长度 ${text.length} 超上限`);
  assert.match(text, /另有 \d+ 个文件未展示/);
});

// ---------------------------------------------------------------- 门禁接受双工具

const callEvent = (turn, name, callId) => ({ type: 'tool/call', data: { turn, step: 1, callId, name, arguments: '{}' } });
const resultEvent = (turn, callId) => ({
  type: 'tool/result',
  data: { turn, step: 2, message: { role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text: 'ok' }] } },
});
const cfgDiff = (digest = 'B1') => ({
  available: true, digest,
  files: [{ path: 'package.json', status: 'M', added: ['x'], removed: [] }],
  totals: { added: 1, removed: 0 },
});

function makeAgent(sid, events) {
  const steered = [];
  return {
    id: `agent-${sid}`,
    steered,
    session: { id: sid, header: { cwd: '/tmp/work', delegationDepth: 0 }, snapshotEvents: () => events },
    steer: (m) => steered.push(m),
  };
}

test('没有调 dsh_code_review → 拦', async () => {
  clearGateState();
  applyConfig({ gate: true });
  const agent = makeAgent('brief-none', []);
  const text = await handleTurnStopping(
    { agent, turn: 1 },
    { collectDiff: async () => cfgDiff('B2'), readJournal: async () => ({ verdict: 'unknown' }) },
  );
  assert.ok(text);
});

// ------------------------------------------------------------ 仓库根反推 + 取不到就抛错

test('repoRootFromObserved：从写过的文件路径向上找到 .git', async () => {
  const { recordWrite, clearObserved, repoRootFromObserved } = await import('../lib/observed.js');
  clearObserved();
  recordWrite('rr', '/a/b/c/repo/lib/x.js');
  // 模拟只有 /a/b/c/repo/.git 存在
  const root = await repoRootFromObserved('rr', {
    exists: async (p) => p === '/a/b/c/repo/.git',
  });
  assert.equal(root, '/a/b/c/repo', '必须向上找到含 .git 的那层');
});

test('repoRootFromObserved：找不到时返回 undefined，不抛', async () => {
  const { recordWrite, clearObserved, repoRootFromObserved } = await import('../lib/observed.js');
  clearObserved();
  recordWrite('rr2', '/x/y/z.js');
  const root = await repoRootFromObserved('rr2', { exists: async () => false });
  assert.equal(root, undefined);
});

test('repoRootFromObserved：没有观察记录时返回 undefined', async () => {
  const { clearObserved, repoRootFromObserved } = await import('../lib/observed.js');
  clearObserved();
  assert.equal(await repoRootFromObserved('nothing', { exists: async () => true }), undefined);
});
