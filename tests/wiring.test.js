import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';
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
