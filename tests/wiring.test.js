import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';
import os from 'node:os';
import { applyConfig } from '../lib/config.js';

/**
 * 接线测试：验 apply() 真的把 agent/turn-stopping 挂上了，并且处理函数返回 promise。
 *
 * 为什么单独测这一层：handleTurnStopping 的测试全绿也说明不了插件生效——
 * 「门禁写好了但没挂上 seam」是静默失效，机器一切绿灯而实际没人拦。
 * 这一层只能靠对 apply() 断言来锁。
 */

function makeCtx() {
  const registered = [];
  const warns = [];
  const infos = [];
  const ctx = {
    on(name, fn) {
      registered.push({ name, fn });
      return () => {};
    },
    effect(fn) {
      const disposer = fn();
      return () => (typeof disposer === 'function' ? disposer() : undefined);
    },
    tools: { register: () => () => {} },
    logger: {
      info: (...a) => infos.push(a),
      warn: (...a) => warns.push(a),
    },
  };
  return { ctx, registered, warns, infos };
}

test('apply 必须挂上 agent/turn-stopping', () => {
  applyConfig({ gate: true });
  const { ctx, registered } = makeCtx();
  apply(ctx, { gate: true });

  const seam = registered.find((r) => r.name === 'agent/turn-stopping');
  assert.ok(seam, '没挂 seam = 门禁静默失效，这是最糟的失败方式');
  assert.equal(typeof seam.fn, 'function');
});

test('turn-stopping 处理函数必须返回 promise（fire-and-forget 会和回合关闭赛跑）', async () => {
  applyConfig({ gate: true });
  const { ctx, registered } = makeCtx();
  apply(ctx, { gate: true });
  const seam = registered.find((r) => r.name === 'agent/turn-stopping');

  const payload = {
    agent: {
      id: 'wiring-1',
      steer() {},
      session: { header: { cwd: '/tmp', delegationDepth: 0 }, snapshotEvents: () => [] },
    },
    turn: 1,
  };

  const ret = seam.fn(payload);
  assert.equal(typeof ret?.then, 'function', '必须返回 promise，否则 steer 会丢');
  await ret;
});

test('没有 agent 的 payload 不应抛错', async () => {
  applyConfig({ gate: true });
  const { ctx, registered } = makeCtx();
  apply(ctx, { gate: true });
  const seam = registered.find((r) => r.name === 'agent/turn-stopping');
  assert.equal(await seam.fn({}), undefined);
  assert.equal(await seam.fn(undefined), undefined);
});

test('seam 挂不上时必须明确告警，不能静默', () => {
  applyConfig({ gate: true });
  const registered = [];
  const warns = [];
  const ctx = {
    on() { return undefined; }, // 模拟宿主的这个 seam 不可用
    effect() { return () => {}; },
    logger: { info() {}, warn: (...a) => warns.push(a) },
  };
  apply(ctx, { gate: true });

  const text = warns.map((w) => String(w[0])).join('\n');
  assert.match(text, /agent\/turn-stopping unavailable/i, '静默失效的门禁比没有门禁更糟');
  assert.equal(registered.length, 0);
});

test('gate:false 时仍挂载但明确标注 disabled（不假装在工作）', () => {
  applyConfig({ gate: false });
  const { ctx, infos } = makeCtx();
  apply(ctx, { gate: false });
  // logger 用 printf 风格（'... %s ...' + 参数），所以要把一行里的所有参数拼起来再断言
  const text = infos.map((i) => i.map(String).join(' ')).join('\n');
  assert.match(text, /disabled by config/i);
});

test('apply 传 undefined 配置不应崩（用默认值）', () => {
  assert.doesNotThrow(() => {
    applyConfig({});
    const { ctx } = makeCtx();
    apply(ctx, undefined);
  });
});

// ---------------------------------------------------------------- 端到端（进程内）

/**
 * 这条覆盖整条降级链：tools/execute 记录 → turn-stopping 读取。
 * 唯一的真风险在于两侧解析出的会话 key 是否一致——只测 handleTurnStopping 覆盖不到。
 */
test('端到端：write 工具写配置类文件 → 非 git 目录下回合结束必须被拦', async () => {
  const { clearGateState } = await import('../lib/gate.js');
  const { clearObserved } = await import('../lib/observed.js');
  clearGateState();
  clearObserved();
  applyConfig({ gate: true });

  const handlers = new Map();
  const ctx = {
    on(name, fn) { handlers.set(name, fn); return () => {}; },
    effect(fn) { const d = fn(); return () => (typeof d === 'function' ? d() : undefined); },
    tools: { register: () => () => {} },
    logger: { info() {}, warn() {} },
  };
  apply(ctx, { gate: true });

  // 1) 模拟一次成功的 write：路径用本仓库真实存在的 package.json
  const target = new URL('../package.json', import.meta.url).pathname;
  const toolHandler = handlers.get('tools/execute');
  assert.ok(toolHandler, 'tools/execute 钩子必须挂上（否则降级取证无数据源）');

  const execution = {
    name: 'write',
    arguments: { file_path: target },
    agent: { session: { id: 'e2e-session' } },
  };
  const result = await toolHandler(execution, async () => ({ ok: true }));
  assert.deepEqual(result, { ok: true }, '钩子必须把 next() 的返回值原样传回');

  // 2) 回合结束：本会话 cwd 非 git，只能走降级取证
  const seam = handlers.get('agent/turn-stopping');
  assert.ok(seam, 'turn-stopping seam 必须挂上');

  const steered = [];
  const agent = {
    id: 'e2e-agent',
    session: {
      id: 'e2e-session',
      header: { cwd: os.tmpdir(), delegationDepth: 0 },
      snapshotEvents: () => [],
    },
    steer: (m) => steered.push(m),
  };
  await seam({ agent, turn: 1 });

  assert.equal(steered.length, 1, 'write 过 package.json 后收尾必须被拦——两侧会话 key 必须对得上');
  assert.equal(steered[0].source.kind, 'review-gate');
  assert.match(JSON.stringify(steered[0]), /降级模式/, '要如实标注取证是降级的');
});

test('端到端：失败的 write 不该被记录', async () => {
  const { clearGateState } = await import('../lib/gate.js');
  const { clearObserved, observedPaths } = await import('../lib/observed.js');
  clearGateState();
  clearObserved();
  applyConfig({ gate: true });

  const handlers = new Map();
  const ctx = {
    on(name, fn) { handlers.set(name, fn); return () => {}; },
    effect(fn) { const d = fn(); return () => (typeof d === 'function' ? d() : undefined); },
    tools: { register: () => () => {} },
    logger: { info() {}, warn() {} },
  };
  apply(ctx, { gate: true });

  const toolHandler = handlers.get('tools/execute');
  await toolHandler(
    { name: 'write', arguments: { file_path: '/tmp/x/package.json' }, agent: { session: { id: 's-fail' } } },
    async () => ({ isError: true }),
  );
  assert.deepEqual(observedPaths('s-fail'), [], 'isError 的写操作不能算改动');
});
