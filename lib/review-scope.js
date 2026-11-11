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
 * 因此：判定「该不该评审」和「审哪里」都必须看写入路径。门禁不代跑任何命令——它只把
 * 写入根（root）和 mismatch 记进状态；发起方是 agent 自己，按实时目录调 dsh_code_review
 * 工具。所以范围选错必须在这里就显式暴露，而不是等到报告出来才发现审错了树。
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
 * @param {{ sessionCwd?: string, sessionRoot?: string, observedRoot?: string }} input
 *   sessionCwd   —— 会话目录
 *   sessionRoot  —— 会话目录所在的 git toplevel（`git rev-parse --show-toplevel`）
 *   observedRoot —— 本会话写过的文件反推出的 git toplevel
 * @returns {{ root: string|undefined, source: 'observed'|'session'|'none', mismatch: boolean, basis: string }}
 *   mismatch = 写入根与会话根是**不同的 git 工作树**（第三方 /review 必然审错树）
 *
 * 注意（2026-11-10 踩过）：不能用「路径包含」判断。`<repo>/.worktrees/feat` 在
 * `<repo>` 之下，但它的 toplevel 就是它自己，而且主仓库的 .gitignore 通常忽略
 * `.worktrees/` —— 主仓库的 `git diff` 一行都看不到。所以必须比 git 根。
 */
export function resolveReviewRoot(input) {
  const sessionCwd = typeof input?.sessionCwd === 'string' && input.sessionCwd !== '' ? input.sessionCwd : undefined
  const sessionRoot = typeof input?.sessionRoot === 'string' && input.sessionRoot !== '' ? input.sessionRoot : undefined
  const observedRoot = typeof input?.observedRoot === 'string' && input.observedRoot !== '' ? input.observedRoot : undefined

  if (observedRoot !== undefined) {
    if (sessionRoot !== undefined) {
      const mismatch = !isInside(observedRoot, sessionRoot) || observedRoot !== sessionRoot
      return { root: observedRoot, source: 'observed', mismatch, basis: 'git-root' }
    }
    // 拿不到会话的 git 根时退化为路径判断（此时嵌套 worktree 判不出来，已知局限）
    const mismatch = sessionCwd !== undefined && !isInside(observedRoot, sessionCwd) && !isInside(sessionCwd, observedRoot)
    return { root: observedRoot, source: 'observed', mismatch, basis: 'path' }
  }
  if (sessionCwd !== undefined) return { root: sessionCwd, source: 'session', mismatch: false, basis: 'none' }
  return { root: undefined, source: 'none', mismatch: false, basis: 'none' }
}
