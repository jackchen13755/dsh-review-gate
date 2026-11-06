/**
 * 有界 Map：门禁的状态全是模块级 Map，长跑进程下会无限增长。
 *
 * 实测（评审探针）：200 个会话 × 50 回合 → sessionSteers 200 条、turnSteers 600 条，
 * 且 reviewedDigest / lastStatus 同样只增不减。DSH 是常驻进程，这属于慢性泄漏。
 *
 * 策略：Map 保持插入顺序，超限就从最老的开始删。门禁的状态本来就是「最近用到的」才有意义
 * （很久以前的回合早已结束），所以按 FIFO 淘汰是安全的，不需要真 LRU。
 */

/** 各类状态的容量上限。数字取「远大于正常并发，但远小于泄漏可察觉的量级」。 */
export const LIMITS = Object.freeze({
  sessions: 500,
  turns: 2000,
  pathsPerSession: 200,
});

/** 超限时从最老的开始删，直到不超限。原地修改，返回同一个 Map。 */
export function capMap(map, max) {
  if (!(map instanceof Map) || !Number.isFinite(max) || max <= 0) return map;
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
  return map;
}

/** 同上，针对 Set。 */
export function capSet(set, max) {
  if (!(set instanceof Set) || !Number.isFinite(max) || max <= 0) return set;
  while (set.size > max) {
    const oldest = set.values().next();
    if (oldest.done) break;
    set.delete(oldest.value);
  }
  return set;
}
