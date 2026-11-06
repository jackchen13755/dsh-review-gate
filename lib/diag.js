/**
 * 诊断日志：把「门禁到底挂没挂上、每次为什么跳过」写进文件。
 *
 * 为什么要有它：ctx.logger 的输出在这个环境里看不到，导致一个反复出现的困境——
 * 「什么都没发生」时无法区分三种情况：
 *   ① apply() 压根没跑（插件没加载）
 *   ② 跑了但 agent/turn-stopping 挂不上（seam 不可用）
 *   ③ 挂上了，但每次收尾都按设计 fail-open
 * 三者修法完全不同，而外部表现一模一样。今天在这个坑里浪费了多轮。
 *
 * 写文件而不是打控制台：控制台日志随 shell 消失，文件能事后查。
 * 有体积上限，超了就轮转一次，避免长期运行把磁盘写满。
 */

import { appendFileSync, existsSync, renameSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { dshHome } from './journal.js';

const MAX_BYTES = 256 * 1024;

/** 插件版本，只读一次。写死版本号会随发版漂移，靠它判断「新代码有没有加载」就会误判。 */
let cachedVersion;
export function pluginVersion() {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    cachedVersion = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

export function diagPath() {
  return path.join(dshHome(), 'review-gate.log');
}

/** 永不抛：诊断失败不能影响门禁本身。 */
export function diag(message) {
  try {
    const file = diagPath();
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      renameSync(file, `${file}.1`);
    }
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // ignore
  }
}
