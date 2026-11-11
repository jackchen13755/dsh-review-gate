/**
 * 「只评审本会话自己改的改动」——归属判定。
 *
 * 场景：同一个分支/同一棵树被多个会话同时改（很常见：一个会话改功能、另一个
 * 修无关的 bug）。`git diff` 看到的是**整棵树**，于是本会话的评审会把别人的改动
 * 一起评进去——既评了不该评的东西，也会让报告把别人的功过算到这次任务头上。
 *
 * 归属依据只能是「本会话实际写过哪些文件」（observed 层），因为我们没有更细的
 * 逐行归属信息。所以这里做的是**文件级**范围收敛，并且刻意保守：
 *
 *   · 观察记录为空（插件刚重载、或全程用 bash 改文件没被记到）→ 不收敛，
 *     按整棵树评（宁可按原行为评，也不要凭空把范围收成空集 → 静默漏审）；
 *   · 观察记录里没有任何路径落在这个仓库下 → 同样不收敛（归属不可判定）；
 *   · 收敛后一个文件都不剩 → 明确告诉调用方「本次改动都不属于本会话」，
 *     由调用方记录为 skipped，而不是当成「没有改动」。
 *
 * 纯函数，便于喂边界输入单测。
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

function toPosix(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '');
}

/** 把绝对路径转成相对仓库根的 POSIX 路径；不在该根下则返回 undefined。 */
export function toRootRelative(absPath, root) {
  if (typeof absPath !== 'string' || absPath.trim() === '') return undefined;
  if (typeof root !== 'string' || root.trim() === '') return undefined;
  const rel = path.relative(root, absPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return toPosix(rel);
}

/**
 * @param {{files?: Array<{path?: string}>}|undefined} diff
 * @param {string[]} observedAbsPaths 本会话写入的绝对路径（observedPaths 的结果）
 * @param {string|undefined} root 评审范围的仓库根
 * @returns {{diff: any, applied: boolean, authored: string[], excluded: string[], reason: string}}
 *   applied=false 表示「无法可靠归属，保持原范围」。
 */
export function scopeDiffToAuthored(diff, observedAbsPaths, root) {
  const files = Array.isArray(diff?.files) ? diff.files : [];
  const passthrough = { diff, applied: false, authored: [], excluded: [], reason: 'not-applicable' };
  if (files.length === 0) return { ...passthrough, reason: 'no-files' };

  const observed = Array.isArray(observedAbsPaths) ? observedAbsPaths : [];
  if (observed.length === 0) return { ...passthrough, reason: 'no-observed-writes' };

  const authored = new Set();
  for (const p of observed) {
    const rel = toRootRelative(p, root);
    if (rel !== undefined) authored.add(rel);
  }
  // 一条都落不到这个仓库：归属不可判定，保持原范围。
  if (authored.size === 0) return { ...passthrough, reason: 'observed-outside-root' };

  const kept = [];
  const excluded = [];
  for (const f of files) {
    const rel = typeof f?.path === 'string' ? toPosix(f.path) : '';
    if (rel !== '' && authored.has(rel)) kept.push(f);
    else excluded.push(rel === '' ? String(f?.path ?? '') : rel);
  }

  // 摘要必须按**收敛后**的文件集重算。
  // 否则别的会话改了与本次无关的文件时，整棵树 digest 变化会让本会话被白重审一次
  // （噪音），而且 reviewed 记录与实际评审范围对不上。
  const digest = createHash('sha256')
    .update(kept.map(f => `${f?.path ?? ''}\u0000${(f?.added ?? []).join('\n')}\u0000${(f?.removed ?? []).join('\n')}`).sort().join('\u0002'))
    .digest('hex');

  return {
    diff: { ...diff, files: kept, digest },
    applied: true,
    authored: [...authored].sort(),
    excluded: excluded.sort(),
    // kept 为空也是一个有效结论：本次 diff 全是别的会话改的。
    reason: kept.length === 0 ? 'all-others' : 'scoped',
  };
}
