import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';
import { applyConfig } from '../lib/config.js';

/**
 * 系统提示注入：让 agent 一开始就知道要优先取证，
 * 而不是干完活被拦下再补一轮（那一轮是白费）。
 */

function makeCtx({ withSystemPrompt = true } = {}) {
  const sections = [];
  const injections = [];
  const ctx = {
    on: () => () => {},
    effect: (fn) => { const d = fn(); return () => (typeof d === 'function' ? d() : undefined); },
    tools: { register: () => () => {} },
    logger: { info() {}, warn() {} },
    // cordis 的可选依赖写法：ctx.inject(deps, cb)
    inject(deps, cb) {
      injections.push(deps);
      if (!withSystemPrompt || !deps.includes('systemPrompt')) return;
      cb({
        systemPrompt: {
          section(opts) { sections.push(opts); return () => {}; },
        },
      });
    },
  };
  return { ctx, sections, injections };
}

test('必须通过 ctx.inject 注册 systemPrompt（可选依赖，不能因为它缺失就整个插件不加载）', () => {
  applyConfig({ gate: true });
  const { ctx, injections } = makeCtx();
  apply(ctx, { gate: true });
  assert.ok(
    injections.some((d) => Array.isArray(d) && d.includes('systemPrompt')),
    '没有注册 systemPrompt 注入，agent 就不会提前知道要优先取证',
  );
});

test('拿不到 systemPrompt 时插件仍能正常 apply（不抛、不中断）', () => {
  applyConfig({ gate: true });
  const { ctx } = makeCtx({ withSystemPrompt: false });
  assert.doesNotThrow(() => apply(ctx, { gate: true }));
});

test('注入一个 review-first 分节，且位置在工具指引之前', () => {
  applyConfig({ gate: true });
  const { ctx, sections } = makeCtx();
  apply(ctx, { gate: true });

  const sec = sections.find((s) => s.name === 'review-gate:review-first');
  assert.ok(sec, '必须注入 review-first 分节');
  assert.equal(typeof sec.order, 'number');
  assert.ok(sec.order < 100, `order=${sec.order} 应在工具指引（100+）之前被读到`);
  assert.equal(typeof sec.text, 'function', 'text 应为函数，便于按配置动态返回');
});

// 契约在 2026-11-11 反转：评审工具 `dsh_code_review` 重新注册（用户要求 agent 可触发），
// 于是「模型无法自己调用」这句不再成立。本用例改为钉住**新**契约：
// 两条路径都要写清（工具 + 命令），且必须明说子 Agent 不要调用（否则递归环复活）。
test('提示词必须讲清两种评审入口（工具 + 命令）、不再推回、子 Agent 禁止调用', () => {
  applyConfig({ gate: true });
  const { ctx, sections } = makeCtx();
  apply(ctx, { gate: true });
  const text = sections.find((s) => s.name === 'review-gate:review-first').text();

  assert.match(text, /dsh_code_review/, '必须写明主会话可直接调用评审工具（否则模型不知道能用它）');
  assert.match(text, /\/review/, '命令路径仍要写明（异步投递、可 --cwd）');
  assert.match(text, /不会再把回合推回|不会.*推回/, '必须说明不再推回，否则模型会做无用的自救');
  assert.doesNotMatch(text, /模型无法自己调用|不再提供工具/, '工具已恢复，这句会让模型放弃调用');
  assert.match(text, /子 Agent[\s\S]{0,40}(不要调用|拿不到|一律)/, '必须讲清子 Agent 不得调用（递归保护）');
  assert.match(text, /不要只提醒用户/, '收尾时该自己取证，不能把取证推给用户');
  assert.doesNotMatch(text, /review_brief/, '自有取证工具已删，不能再出现在提示词里');
  assert.match(text, /lens/, '结构性改动要提 lens');
  assert.match(text, /impact.*circular.*metrics/, 'lens 要具体到三个动作');
  assert.match(text, /package\.json/, '要举出配置类文件的具体例子');
  assert.match(text, /新增或删除代码文件/, '要讲清 structural 的判据');
  assert.match(text, /边界输入/, '要提醒逐条回答什么');
  assert.match(text, /未评审/, '拿不到证据时要如实说，不能装作审过');
});

test('门禁关闭时注入空文本（不打扰）', () => {
  applyConfig({ gate: false });
  const { ctx, sections } = makeCtx();
  apply(ctx, { gate: false });
  const sec = sections.find((s) => s.name === 'review-gate:review-first');
  assert.ok(sec, '仍应注册分节');
  assert.equal(sec.text(), '', 'gate=false 时不该往系统提示里塞内容');
});
