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

/**
 * 路径归一化：**唯一一份实现**，isInside 与 reviewKeyOf 共用。
 *
 * 为什么必须共用：两处各写一份必然漂移——一处把 `/repo/` 当 `/repo`，另一处不当，
 * 结果就是「按 A 口径算出的键」与「按 B 口径判定的包含关系」互相矛盾，
 * 而两边都不会报错，只会静默错判（评审范围串仓 / 假放行）。
 *
 * 返回去掉**全部**尾斜杠的字符串；非字符串 / 空串 → undefined（怎么兜底由调用方决定：
 * isInside 判 false，reviewKeyOf 用占位符）。
 */
function normalizeRoot(p) {
  if (typeof p !== 'string') return undefined
  let out = p
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  if (out === '') return undefined
  return out
}

/** a 是否等于 b 或位于 b 之下。 */
export function isInside(a, b) {
  const left = normalizeRoot(a)
  const right = normalizeRoot(b)
  if (left === undefined || right === undefined) return false
  return left === right || left.startsWith(`${right}/`)
}

// 占位符：区分「没给 root」（宿主没传）与「给了但为空/非字符串」（数据坏了）。
// 两类都不能与真实 root 撞键，否则「不知道审哪棵树」会被并进某个真实仓库的分区。
const ROOT_MISSING = '\u0001missing-root'
const ROOT_EMPTY = '\u0001empty-root'
const ROOT_INVALID = '\u0001invalid-root'
const SESSION_INVALID = '\u0001invalid-session'

/**
 * 基线与「已评审摘要」的键：`(会话, 仓库根)`。
 *
 * 为什么键里必须带 root（2026-11-11）：一个会话可以同时改多个仓库（工作区根常常是
 * 多个仓库的父目录）。只按 sessionId 存会导致两类错：
 *   1. 换仓后仍拿 A 仓的文件当基线 → reviewScope 里出现 A 仓的文件，把复审引偏；
 *   2. digest 里不含 root，B 仓里内容恰好与 A 仓已评审那版相同 → 被判「已评审」
 *      而**一个字都没审**（false pass，比串范围更严重）。
 * 所以同一个会话在不同 root 下各留各的键，基线也不互相弃用。
 *
 * 用 NUL 分隔：它不可能出现在路径里，所以 (session, root) 拼接不会互相串味。
 *
 * @param {unknown} sessionId
 * @param {unknown} root 仓库根（diff 实际取证的那棵树）
 * @returns {string} 稳定可比较的键
 */
export function reviewKeyOf(sessionId, root) {
  const session = typeof sessionId === 'string' && sessionId !== '' ? sessionId : SESSION_INVALID
  let rootPart
  if (typeof root === 'string') {
    const normalized = normalizeRoot(root)
    // 空串 / 纯斜杠：给了值但不可用 → 与「没给」区分开
    rootPart = normalized === undefined ? ROOT_EMPTY : normalized
  } else if (root === undefined || root === null) {
    rootPart = ROOT_MISSING
  } else {
    rootPart = ROOT_INVALID
  }
  return `${session}\u0000${rootPart}`
}

/**
 * @param {{ sessionCwd?: string, sessionRoot?: string, observedRoot?: string }} input
 *   sessionCwd   —— 会话目录
 *   sessionRoot  —— 会话目录所在的 git toplevel（`git rev-parse --show-toplevel`）
 *   observedRoot —— 本会话写过的文件反推出的 git toplevel
 * @returns {{ root: string|undefined, source: 'observed'|'session'|'none', mismatch: boolean, basis: string }}
 *   mismatch = 写入根与会话根是**不同的 git 工作树**（不代跑评审，所以这里只负责把范围显式暴露出来）
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
