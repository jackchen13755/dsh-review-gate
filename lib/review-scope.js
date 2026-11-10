/**
 * 评审范围：以「本会话实际写过的文件」为准，而不是会话创建时的目录。
 *
 * 2026-11-10 实测（真实会话）：
 *   会话 header.cwd = <主仓库>
 *   21 次 edit 全部落在 <主仓库>/.worktrees/<feat>/…  （另一个工作树）
 *   → `/review` 在主仓库跑 `git diff`，那里没有这些改动，评审看到的是「主区域」。
 *
 * 为什么会这样：`@michengai/dsh-code-review` 的 runtime.js 用
 * `parent.session.header.cwd` 取 diff；而 DSH 的 header.cwd 只是
 * `workingDirectory` projection 的**初始值**（init: header => header.cwd ?? null），
 * 之后目录变化由 `working-directory/change` 事件维护，header 不再更新。
 * 会话里用绝对路径改另一个工作树时，header 更是完全不变。
 *
 * 因此：判定「该不该评审」和「审哪里」都必须看写入路径；而真正发起 `/review` 时，
 * 若写入根与会话根不一致，第三方必然审错树——那就拒绝发起并说清该在哪个目录开会话。
 */

/** a 是否等于 b 或位于 b 之下。 */
export function isInside(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false
  const norm = (p) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p)
  const left = norm(a)
  const right = norm(b)
  return left === right || left.startsWith(`${right}/`)
}

/**
 * @param {{ sessionCwd?: string, observedRoot?: string }} input
 *   sessionCwd   —— 会话当前（或创建时）目录
 *   observedRoot —— 本会话写过的文件反推出的仓库/工作树根
 * @returns {{ root: string|undefined, source: 'observed'|'session'|'none', mismatch: boolean }}
 *   mismatch = 写入根与会话根互不包含（第三方 /review 必然审错树）
 */
export function resolveReviewRoot(input) {
  const sessionCwd = typeof input?.sessionCwd === 'string' && input.sessionCwd !== '' ? input.sessionCwd : undefined
  const observedRoot = typeof input?.observedRoot === 'string' && input.observedRoot !== '' ? input.observedRoot : undefined

  if (observedRoot !== undefined) {
    const mismatch = sessionCwd !== undefined && !isInside(observedRoot, sessionCwd) && !isInside(sessionCwd, observedRoot)
    return { root: observedRoot, source: 'observed', mismatch }
  }
  if (sessionCwd !== undefined) return { root: sessionCwd, source: 'session', mismatch: false }
  return { root: undefined, source: 'none', mismatch: false }
}
