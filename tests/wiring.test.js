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
test('端到端：write 工具写配置类文件 → cwd 非 git 时按仓库根取证并拦下', async () => {
  const { execFileSync } = await import('node:child_process');
  const fsp = await import('node:fs');
  const pathp = await import('node:path');
  const { clearGateState } = await import('../lib/gate.js');
  const { clearObserved } = await import('../lib/observed.js');
  clearGateState();
  clearObserved();
  applyConfig({ gate: true });

  // 自持夹具：临时 git 仓库 + 一次提交 + 一处未提交改动。
  //
  // 以前这里写的是本仓库真实的 package.json，于是「生产工作树有没有未提交改动」
  // 直接决定这条用例成败（提交之后就恒绿或恒红）。夹具必须自带状态。
  const base = fsp.mkdtempSync(pathp.join(os.tmpdir(), 'wiring-repo-'));
  const repo = pathp.join(base, 'repo');
  fsp.mkdirSync(repo, { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git(['init', '-q']);
  const pkg = pathp.join(repo, 'package.json');
  fsp.writeFileSync(pkg, '{\n  "name": "fixture",\n  "version": "1.0.0"\n}\n');
  git(['add', 'package.json']);
  git(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  fsp.writeFileSync(pkg, '{\n  "name": "fixture",\n  "version": "1.0.1"\n}\n'); // 未提交改动

  const handlers = new Map();
  const ctx = {
    on(name, fn) { handlers.set(name, fn); return () => {}; },
    effect(fn) { const d = fn(); return () => (typeof d === 'function' ? d() : undefined); },
    tools: { register: () => () => {} },
    logger: { info() {}, warn() {} },
  };
  apply(ctx, { gate: true });

  // 1) 模拟一次成功的 write
  const toolHandler = handlers.get('tools/execute');
  assert.ok(toolHandler, 'tools/execute 钩子必须挂上（否则降级取证无数据源）');
  const execution = {
    name: 'write',
    arguments: { file_path: pkg },
    agent: { session: { id: 'e2e-session' } },
  };
  const result = await toolHandler(execution, async () => ({ ok: true }));
  assert.deepEqual(result, { ok: true }, '钩子必须把 next() 的返回值原样传回');

  // 2) 回合结束：cwd 是个不含 .git 的临时目录，门禁必须反推出仓库根
  const nonRepo = fsp.mkdtempSync(pathp.join(os.tmpdir(), 'wiring-cwd-'));
  const seam = handlers.get('agent/turn-stopping');
  assert.ok(seam, 'turn-stopping seam 必须挂上');

  const steered = [];
  const agent = {
    id: 'e2e-agent',
    session: {
      id: 'e2e-session',
      header: { cwd: nonRepo, delegationDepth: 0 },
      snapshotEvents: () => [],
    },
    steer: (m) => steered.push(m),
  };
  await seam({ agent, turn: 1 });

  assert.equal(steered.length, 1, 'write 过 package.json 后收尾必须被拦——两侧会话 key 必须对得上');
  assert.equal(steered[0].source.kind, 'review-gate');
  assert.equal(
    /降级模式/.test(JSON.stringify(steered[0])),
    false,
    '反推到仓库根后拿到的是真 diff，不该再标成降级取证',
  );

  fsp.rmSync(base, { recursive: true, force: true });
  fsp.rmSync(nonRepo, { recursive: true, force: true });
});

test('端到端：确实反推不出仓库根时，仍如实标注降级取证', async () => {
  const { clearGateState } = await import('../lib/gate.js');
  const { clearObserved } = await import('../lib/observed.js');
  const fsp = await import('node:fs');
  const pathp = await import('node:path');
  clearGateState();
  clearObserved();
  applyConfig({ gate: true });

  // 文件与 cwd 都在「上溯 12 层也找不到 .git」的临时目录里
  const lonely = fsp.mkdtempSync(pathp.join(os.tmpdir(), 'wiring-lonely-'));
  const target = pathp.join(lonely, 'package.json');
  fsp.writeFileSync(target, '{ "name": "x" }\n');

  const handlers = new Map();
  const ctx = {
    on(name, fn) { handlers.set(name, fn); return () => {}; },
    effect(fn) { const d = fn(); return () => (typeof d === 'function' ? d() : undefined); },
    tools: { register: () => () => {} },
    logger: { info() {}, warn() {} },
  };
  apply(ctx, { gate: true });

  await handlers.get('tools/execute')(
    { name: 'write', arguments: { file_path: target }, agent: { session: { id: 'lonely-session' } } },
    async () => ({ ok: true }),
  );

  const steered = [];
  const agent = {
    id: 'lonely-agent',
    session: { id: 'lonely-session', header: { cwd: lonely, delegationDepth: 0 }, snapshotEvents: () => [] },
    steer: (m) => steered.push(m),
  };
  await handlers.get('agent/turn-stopping')({ agent, turn: 1 });

  assert.equal(steered.length, 1, '没有仓库根时只能靠观察记录，但仍然必须拦');
  assert.match(JSON.stringify(steered[0]), /降级模式/, '取证确实是降级的，必须如实标注');
  fsp.rmSync(lonely, { recursive: true, force: true });
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

test('必须声明 inject 依赖 tools（否则 ctx.tools 未就位、工具注册被静默跳过）', async () => {
  const mod = await import('../lib/index.js');
  assert.ok(Array.isArray(mod.inject), '必须导出 inject 数组');
  assert.ok(mod.inject.includes('tools'), 'inject 必须包含 tools —— v0.4.0 及之前漏了这条，review_gate_status 在所有会话里都不存在');
});

test('渲染的 steer 文本必须给出「没有工具时怎么办」的退路', async () => {
  const { renderGateText } = await import('../lib/gate.js');
  const text = renderGateText(['config'], { files: [{}], partial: false });
  assert.match(text, /dsh_code_review/);
  assert.match(text, /没有 .* 这个工具|本会话没有/, '拿不到工具的会话需要有诚实的退路，不能静默收工');
});

test('端到端：write 新建文件 → created 必须在写入前判定（这条是实机失败后补的）', async () => {
  const { clearGateState } = await import('../lib/gate.js');
  const { clearObserved, observedSnapshot } = await import('../lib/observed.js');
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
  // 目标是一个【当前不存在】的路径
  const target = '/tmp/__never_exists_gate_test__/brand-new.js';
  const execution = { name: 'write', arguments: { file_path: target }, agent: { session: { id: 'created-e2e' } } };

  let existedAtNext = null;
  await toolHandler(execution, async () => {
    // next() 执行时（即写入时刻），这个路径还不存在
    const { existsSync } = await import('node:fs');
    existedAtNext = existsSync(target);
    return { ok: true };
  });
  assert.equal(existedAtNext, false, '前提：写入时文件确实还不存在');

  const snap = await observedSnapshot('created-e2e', {
    readFile: async () => 'export const x = 1',
    cwd: '/',
  });
  assert.equal(snap.files[0].status, 'A',
    '写入前不存在的文件必须记成 A —— 实机失败就是因为判在了写入之后');
});

test('端到端：write 覆盖已存在文件 → 记 M，不误报新增', async () => {
  const { clearObserved, observedSnapshot } = await import('../lib/observed.js');
  clearObserved();
  const handlers = new Map();
  const ctx = {
    on(name, fn) { handlers.set(name, fn); return () => {}; },
    effect(fn) { const d = fn(); return () => (typeof d === 'function' ? d() : undefined); },
    tools: { register: () => () => {} },
    logger: { info() {}, warn() {} },
  };
  apply(ctx, { gate: true });
  const toolHandler = handlers.get('tools/execute');

  // package.json 一定存在
  const target = new URL('../package.json', import.meta.url).pathname;
  await toolHandler(
    { name: 'write', arguments: { file_path: target }, agent: { session: { id: 'exist-e2e' } } },
    async () => ({ ok: true }),
  );
  const snap = await observedSnapshot('exist-e2e', { readFile: async () => '{}', cwd: '/' });
  assert.equal(snap.files[0].status, 'M', '覆盖已有文件不该被当成新增');
});
