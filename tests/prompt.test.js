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

test('提示词必须讲清「评审改由 /review 命令触发、不会再推回」，并给出按改动类型的做法', () => {
  applyConfig({ gate: true });
  const { ctx, sections } = makeCtx();
  apply(ctx, { gate: true });
  const text = sections.find((s) => s.name === 'review-gate:review-first').text();

  assert.match(text, /\/review/, '必须写明评审由 /review 命令触发');
  assert.match(text, /不会再把回合推回|不会.*推回/, '必须说明不再推回，否则模型会做无用的自救');
  assert.doesNotMatch(text, /dsh_code_review/, '1.0.9+ 已无该工具，提示词不能再提');
  assert.match(text, /提醒用户/, '要告诉模型：收尾时提醒用户跑 /review');
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
