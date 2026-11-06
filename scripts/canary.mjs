#!/usr/bin/env node
/**
 * 变异检定入口：`npm run canary`（或 `node scripts/canary.mjs [spec.json]`）。
 *
 * 退出码语义（**这是闸门的判据，不是「跑完了」**）：
 *   0 = 每条变异体都被自己声明的 `expectRed` 断言杀死（拿到了证明）
 *   1 = 有变异体存活 / 被别的断言杀死 / 条目规格无效 / 无法判定
 *
 * 为什么「存活」也算失败：本脚本的用途是回答「新增的那条断言真的会红吗」。
 * 变异体存活恰恰说明它不会红——那不是脚本坏了，是断言没覆盖到，必须让
 * 调用方（CI / 门禁）看到红色，否则它只会被记成「跑过了」。
 *
 * 注意：这条判据只证明「存在一条会红的断言」，**不证明**那条断言判对了逻辑。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCanary, MUTANT_VERDICT } from '../lib/canary.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const specPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'mutants.json');

let spec;
try {
  spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
} catch (e) {
  console.error(`✖ 读不到变异体清单：${specPath}\n  ${e.message}`);
  process.exit(1);
}

const receipt = runCanary({
  cwd: root,
  baselineCmd: spec.baselineCmd,
  mutants: spec.mutants,
});

console.log(JSON.stringify(receipt, null, 2));

const mutants = Array.isArray(receipt.mutants) ? receipt.mutants : [];
const survivors = mutants.filter((m) => m.verdict !== MUTANT_VERDICT.KILLED_BY_ASSERTION);
const proven = receipt.status === 'ok' && mutants.length > 0 && survivors.length === 0;

if (proven) {
  console.log(`\n✅ ${mutants.length} 条变异体全部被具名断言杀死`);
  process.exit(0);
}

console.error('\n✖ 未拿到证明：');
if (receipt.status !== 'ok') console.error(`  - 引擎结论为 ${receipt.status}：${receipt.reason ?? '（见 mutants）'}`);
for (const m of survivors) {
  console.error(`  - ${m.id} → ${m.verdict}${m.reason ? `（${m.reason}）` : ''}`);
}
process.exit(1);
