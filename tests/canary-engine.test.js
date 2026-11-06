import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runCanary,
  decideMutant,
  parseTap,
  substituteOnce,
  MUTANT_VERDICT,
  CANARY_STATUS,
  CANARY_STATE,
  canaryStateOf,
  recordReceipt,
  clearCanaryState,
} from '../lib/canary.js';

/**
 * 现场造一个迷你仓库：一个模块 + 一条带 @canary 名的边界断言。
 * 用它验证引擎的两个方向——该杀的必须杀掉，等价变异体必须判 SURVIVED。
 */
function makeMiniRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-mini-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(
    path.join(dir, 'foo.js'),
    [
      '// 边界值判定',
      'export function ok(n, limit) {',
      '  if (n >= limit) return false;',
      '  return true;',
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, 'foo.test.js'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { ok } from './foo.js';",
      '',
      "test('boundary @canary id=foo.limit', () => {",
      '  assert.equal(ok(5, 5), false);',
      '  assert.equal(ok(4, 5), true);',
      '});',
      '',
    ].join('\n'),
  );
  return dir;
}

const TAP_ONE = 'node --test --test-reporter=tap foo.test.js';

test('引擎：边界变异体必须被判 KILLED_BY_ASSERTION', () => {
  const cwd = makeMiniRepo();
  const r = runCanary({
    cwd,
    baselineCmd: TAP_ONE,
    mutants: [
      { id: 'foo.limit', file: 'foo.js', old: 'if (n >= limit) return false;', new: 'if (n > limit) return false;', expectRed: '@canary id=foo.limit' },
    ],
  });
  assert.equal(r.status, CANARY_STATUS.OK, `引擎本身应正常，实际 ${r.status} ${r.reason ?? ''}`);
  assert.equal(r.mutants[0].verdict, MUTANT_VERDICT.KILLED_BY_ASSERTION);
  assert.ok(r.mutants[0].redAssertions.some((n) => n.includes('@canary id=foo.limit')));
});

test('引擎：等价变异体（只改注释）必须判 SURVIVED，不能记成失败', () => {
  const cwd = makeMiniRepo();
  const r = runCanary({
    cwd,
    baselineCmd: TAP_ONE,
    mutants: [
      { id: 'foo.comment', file: 'foo.js', old: '// 边界值判定', new: '// 边界值判定（改写）', expectRed: '@canary id=foo.limit' },
    ],
  });
  assert.equal(r.status, CANARY_STATUS.OK);
  assert.equal(
    r.mutants[0].verdict,
    MUTANT_VERDICT.SURVIVED,
    '改注释不该让测试红。判成失败会逼人写垃圾断言',
  );
});

test('引擎：前像对不上 → SPEC_INVALID，不猜也不崩', () => {
  const cwd = makeMiniRepo();
  const r = runCanary({
    cwd,
    baselineCmd: TAP_ONE,
    mutants: [
      { id: 'foo.stale', file: 'foo.js', old: '这行代码不存在', new: 'x', expectRed: '@canary id=foo.limit' },
    ],
  });
  assert.equal(r.status, CANARY_STATUS.SPEC_INVALID);
  assert.equal(r.mutants[0].verdict, MUTANT_VERDICT.SPEC_INVALID);
  assert.match(r.mutants[0].reason, /出现 0 次/);
});

test('引擎：报告器不是 TAP（基线解析到 0 条）→ 必须判 undetermined，不能判通过', () => {
  const cwd = makeMiniRepo();
  const r = runCanary({
    cwd,
    baselineCmd: 'node --test foo.test.js', // 默认 spec 报告器，解析不出 TAP
    mutants: [
      { id: 'foo.limit', file: 'foo.js', old: 'if (n >= limit) return false;', new: 'if (n > limit) return false;', expectRed: '@canary id=foo.limit' },
    ],
  });
  assert.equal(r.status, CANARY_STATUS.UNDETERMINED);
  assert.match(r.reason, /解析到 0 条用例/);
});

test('引擎：没有变异体（空清单）不许算通过', () => {
  const r = runCanary({ cwd: makeMiniRepo(), baselineCmd: TAP_ONE, mutants: [] });
  assert.equal(r.status, CANARY_STATUS.UNDETERMINED);
});

// ------------------------------------------------ 判决函数本身（喂边界输入）

test('判决：文件级条目（加载失败）不许算作杀死断言', () => {
  // 改名导出会让整份文件加载失败，红的是文件级条目——一条断言都没红。
  const d = decideMutant({
    baseline: { pass: ['a @canary id=x', 'b'], fail: [] },
    mutantFail: ['/tmp/foo.test.js'],
    expectRed: '@canary id=x',
  });
  assert.equal(d.verdict, MUTANT_VERDICT.SURVIVED, 'exit code 非 0 不等于断言红了');
});

test('判决：红了别条断言 → 降级 OTHER_ASSERTION，不许冒充', () => {
  const d = decideMutant({
    baseline: { pass: ['a @canary id=x', 'b'], fail: [] },
    mutantFail: ['b'],
    expectRed: '@canary id=x',
  });
  assert.equal(d.verdict, MUTANT_VERDICT.KILLED_BY_OTHER_ASSERTION);
  assert.deepEqual(d.redAssertions, ['b']);
});

test('判决：基线里本来就是红的不算本次杀死', () => {
  const d = decideMutant({
    baseline: { pass: ['a @canary id=x'], fail: ['c'] },
    mutantFail: ['c'],
    expectRed: '@canary id=x',
  });
  assert.equal(d.verdict, MUTANT_VERDICT.SURVIVED);
});

test('判决：没声明 expectRed → SPEC_INVALID（无法判断红的是不是那条）', () => {
  const d = decideMutant({ baseline: { pass: ['a'], fail: [] }, mutantFail: ['a'] });
  assert.equal(d.verdict, MUTANT_VERDICT.SPEC_INVALID);
});

test('判决：SKIP / TODO 条目不算用例', () => {
  const p = parseTap(['TAP version 13', 'ok 1 - skipped one # SKIP 后面再说', 'ok 2 - real one', 'not ok 3 - broken one'].join('\n'));
  assert.deepEqual(p.pass, ['real one']);
  assert.deepEqual(p.fail, ['broken one']);
});

// ------------------------------------------------ 审查发现的假绿（逐条钉住）

test('引擎：变异体那一跑没有 TAP 输出（命令没跑起来）→ SPEC_INVALID，不许判 SURVIVED', () => {
  const cwd = makeMiniRepo();
  const r = runCanary({
    cwd,
    baselineCmd: TAP_ONE,
    mutants: [
      {
        id: 'foo.dead-cmd',
        file: 'foo.js',
        old: 'if (n >= limit) return false;',
        new: 'if (n > limit) return false;',
        expectRed: '@canary id=foo.limit',
        cmd: '__no_such_binary_xyz__ --test',
      },
    ],
  });
  // 命令压根没跑，任何「存活」结论都是假的：必须是「无法判定这一条」。
  // 两种可能都要算 fail-closed：①它自带的命令基线就跑不起来（先把这条逮住）
  // ②基线能跑但变异体那一跑没有 TAP。
  assert.equal(r.status, CANARY_STATUS.SPEC_INVALID);
  assert.equal(r.mutants[0].verdict, MUTANT_VERDICT.SPEC_INVALID);
  assert.match(r.mutants[0].reason, /基线不可用|没有 TAP 输出/);
  assert.equal(r.killed, false);
});

test('引擎：畸形条目（漏 file / new 不是字符串）→ SPEC_INVALID，不许抛异常', () => {
  const cwd = makeMiniRepo();
  const r = runCanary({
    cwd,
    baselineCmd: TAP_ONE,
    mutants: [
      { id: 'missing-file', old: 'if (n >= limit) return false;', new: 'x', expectRed: '@canary id=foo.limit' },
      { id: 'bad-new', file: 'foo.js', old: 'if (n >= limit) return false;', new: 42, expectRed: '@canary id=foo.limit' },
      null,
    ],
  });
  assert.equal(r.status, CANARY_STATUS.SPEC_INVALID);
  assert.equal(r.mutants.length, 3);
  for (const m of r.mutants) assert.equal(m.verdict, MUTANT_VERDICT.SPEC_INVALID);
});

test('替换：后像里的 $& / $$ 不许被展开（否则真变异会变成空操作）', () => {
  const src = 'const a = 1;\nconst b = 2;\n';
  // 直接 String.replace 会把 $& 换成匹配到的原文
  assert.equal(src.replace('const a = 1;', 'const a = "$&";'), 'const a = "const a = 1;";\nconst b = 2;\n');
  // 引擎用的替换必须是纯字面量
  assert.equal(substituteOnce(src, 'const a = 1;', 'const a = "$&";'), 'const a = "$&";\nconst b = 2;\n');
  assert.equal(substituteOnce(src, 'const a = 1;', 'const a = "$$";'), 'const a = "$$";\nconst b = 2;\n');
});

test('替换：后像不是字符串必须抛错，不能把 undefined 写进源码', () => {
  assert.throws(() => substituteOnce('const a = 1;', 'const a = 1;', undefined), /必须是字符串/);
});

test('引擎：跑完不许在临时目录留副本（实测积过 82 份整仓拷贝）', () => {
  const tmp = os.tmpdir();
  // 注意排除 canary-mini-：那是本测试自己造的迷你仓库，同样以 canary- 开头。
  const isWorkdir = (n) => n.startsWith('canary-') && !n.startsWith('canary-mini-');
  const before = new Set(fs.readdirSync(tmp).filter(isWorkdir));
  const cwd = makeMiniRepo();
  const r = runCanary({
    cwd,
    baselineCmd: TAP_ONE,
    mutants: [
      { id: 'foo.limit', file: 'foo.js', old: 'if (n >= limit) return false;', new: 'if (n > limit) return false;', expectRed: '@canary id=foo.limit' },
    ],
  });
  assert.equal(r.status, CANARY_STATUS.OK);
  assert.equal(r.workdir, undefined, '默认不该把 workdir 暴露出去');
  const leaked = fs.readdirSync(tmp).filter((n) => isWorkdir(n) && !before.has(n));
  assert.deepEqual(leaked, [], `跑完必须回收隔离副本，实际残留：${leaked.join(', ')}`);
});

// ------------------------------------------------ shadow 状态（只看有没有，不参与放行）

test('shadow 状态：没有回执 → missing；有但没杀死 → unproven；杀死了 → verified', () => {
  clearCanaryState();
  const sid = 's-shadow';
  assert.equal(canaryStateOf(sid), CANARY_STATE.MISSING);
  recordReceipt(sid, { killed: false });
  assert.equal(canaryStateOf(sid), CANARY_STATE.UNPROVEN);
  recordReceipt(sid, { killed: true });
  assert.equal(canaryStateOf(sid), CANARY_STATE.VERIFIED);
  // 非法 sid 不该污染状态表
  recordReceipt(undefined, { killed: true });
  assert.equal(canaryStateOf(undefined), CANARY_STATE.MISSING);
  clearCanaryState();
});
