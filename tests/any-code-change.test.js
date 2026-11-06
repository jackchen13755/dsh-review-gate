import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyTrigger, REASONS } from '../lib/trigger.js';
import { applyConfig, getConfig } from '../lib/config.js';

/**
 * 「改完代码不自动评审」那个反馈的直接回归。
 *
 * 实测来源：session-c862e3b5 的 turn=1 在日志里是 skipped=- / reasons=（空）——
 * 有改动，但七条规则一条都没命中，门禁一声不响，用户只能手动开评审。
 * 这条兜底规则把「哪里最危险」和「哪里改了」分开：七条负责前者，它负责后者。
 */

const f = (path, added = [], removed = [], status = 'M') => ({ path, added, removed, status });
const snap = (files) => ({
  available: true,
  files,
  totals: files.reduce(
    (a, x) => ({ added: a.added + (x.added?.length ?? 0), removed: a.removed + (x.removed?.length ?? 0) }),
    { added: 0, removed: 0 },
  ),
});

test('单文件改一行代码（七条规则都不命中）→ 必须判 code 并触发', () => {
  // 这就是 c862e3b5 那类改动：动一个文件、一行、不碰配置/边界/安全面
  const r = classifyTrigger(snap([f('src/calc.js', ['  const total = count + 1;'], [])]));
  assert.ok(r.trigger, `一行代码改动必须触发评审，实际 reasons=${JSON.stringify(r.reasons)}`);
  assert.ok(r.reasons.includes(REASONS.CODE), '要标明是兜底规则命中的');
});

test('纯注释改动 → 不触发（兜底规则只认代码变更）', () => {
  const r = classifyTrigger(snap([f('src/calc.js', ['  // 这里补一句说明'], [])]));
  assert.equal(r.trigger, false, `纯注释不该被拦，实际 reasons=${JSON.stringify(r.reasons)}`);
});

test('纯文档改动 → 不触发', () => {
  const r = classifyTrigger(snap([f('README.md', ['补充一段说明'], [])]));
  assert.equal(r.trigger, false, `文档改动不该被拦，实际 reasons=${JSON.stringify(r.reasons)}`);
});

test('reviewAnyCodeChange=false → 退回旧行为（只认七条规则）', () => {
  const r = classifyTrigger(snap([f('src/calc.js', ['  const total = count + 1;'], [])]), { reviewAnyCodeChange: false });
  assert.equal(r.trigger, false, '关掉开关后不该再触发');
});

test('已命中具体规则时不再额外塞 code（保持原因精确）', () => {
  const r = classifyTrigger(snap([f('package.json', ['  "x": 1'], [])]));
  assert.ok(r.reasons.includes(REASONS.CONFIG));
  assert.equal(r.reasons.includes(REASONS.CODE), false, 'code 只做兜底，不抢具体规则的结论');
});

test('默认配置开着兜底、且每会话预算够用（否则兜底会被预算架空）', () => {
  applyConfig({});
  const c = getConfig();
  assert.equal(c.reviewAnyCodeChange, true, '默认应当开着——用户要的就是「改完自动评审」');
  assert.ok(c.gateMaxSteersPerSession >= 10, `每会话预算太小会让兜底规则在第 N 回合后静默失效，实际 ${c.gateMaxSteersPerSession}`);
});
