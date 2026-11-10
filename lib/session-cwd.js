/**
 * 会话目录解析：**绝不用进程 cwd**。
 *
 * 为什么必须有这一层（2026-11-10 实测）：
 *  - `agent.session.header.cwd` 是会话**创建时**写入的身份字段，宿主只用它做恢复冲突
 *    （ApiSessionCwdConflict）与列表归组，**没有任何代码在 cd 之后更新它**。
 *  - 会话中途切目录（worktree、working_directory 工具）走的是
 *    `ctx.workingDirectory.set(agent, path)`，实时值只能从
 *    `ctx.workingDirectory.get(agent.session)` 取。
 *  - `process.cwd()` 是**宿主进程**的目录，所有会话共用一份；拿它兜底等于让不同会话
 *    互相评审对方的树（多会话并行时交叉污染）。
 *
 * 所以优先级只有两级，第二级拿不到就返回 `undefined` 让上层放弃取证，而不是兜底。
 *
 * 纯函数，便于喂边界输入单测。
 */

/**
 * @param {{ live?: unknown, header?: unknown }} input
 *   live   —— ctx.workingDirectory.get(session) 的返回值（实时目录，可能 undefined / 抛错后为 undefined）
 *   header —— session.header.cwd（创建时目录，可能缺失）
 * @returns {{ cwd: string|undefined, source: 'live'|'header'|'none', stale: boolean }}
 *   stale = 实时目录与创建时目录不一致（会话中途切过目录）——第三方 /review 按 header 取 diff，
 *   这种情况它会审错树，调用方必须据此拒绝自动评审。
 */
export function resolveSessionCwd(input) {
  const live = typeof input?.live === 'string' && input.live.trim() !== '' ? input.live.trim() : undefined
  const header = typeof input?.header === 'string' && input.header.trim() !== '' ? input.header.trim() : undefined
  if (live !== undefined) {
    return { cwd: live, source: 'live', stale: header !== undefined && header !== live }
  }
  if (header !== undefined) {
    // 没有实时值可依赖：可能是老宿主没有 workingDirectory，或读取抛错。
    // 用 header 但不声称它是最新的（stale 未知，按 false 处理以免误拦正常会话）。
    return { cwd: header, source: 'header', stale: false }
  }
  return { cwd: undefined, source: 'none', stale: false }
}
