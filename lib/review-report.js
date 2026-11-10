/**
 * 1.0.9+ 的 `@michengai/dsh-code-review` 不再注册 `dsh_code_review` 工具，改成 /review 命令；
 * 审查完成后它会把报告以**用户消息**注入当前会话（`agent.followup`），source.kind 固定为
 * `michengai-code-review`：
 *
 *   Here is the completed code review report: …      ← 成功
 *   The code review did not complete: …              ← 失败 / 中断
 *
 * 这条消息由宿主写入会话日志（不是模型自述），所以可以当评估证据。
 * 纯函数：吃事件数组，吐结论，便于喂边界输入单测。
 */

/** 第三方插件注入消息时用的 source.kind。 */
export const REPORT_SOURCE_KIND = 'michengai-code-review'

const COMPLETED_PREFIX = 'Here is the completed code review report'
const FAILED_PREFIX = 'The code review did not complete'

function textOf(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block && typeof block === 'object' && block.type === 'text' ? String(block.text ?? '') : ''))
    .join('\n')
}

/**
 * @param {any[]} events 会话事件数组
 * @returns {{ seen: boolean, completed: boolean, failed: boolean, index: number }}
 *   index = 最近一条评审消息在事件数组里的位置（没找到为 -1），用于判断「审完又改」。
 */
export function findReviewReport(events) {
  const list = Array.isArray(events) ? events : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const event = list[i]
    if (event === null || typeof event !== 'object') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    const message = data.message
    if (message === null || typeof message !== 'object') continue
    const source = message.source
    if (source === null || typeof source !== 'object') continue
    if (source.kind !== REPORT_SOURCE_KIND) continue
    if (message.role !== undefined && message.role !== 'user') continue
    const text = textOf(message)
    const completed = text.startsWith(COMPLETED_PREFIX)
    return { seen: true, completed, failed: !completed || text.startsWith(FAILED_PREFIX), index: i }
  }
  return { seen: false, completed: false, failed: false, index: -1 }
}

/**
 * 报告之后有没有再改代码：拿最后一次写类工具调用的位置和报告位置比。
 * 只认 edit / write / multi_edit 这类直接写文件工具的**位置**（会话日志里的顺序）。
 * @param {any[]} events
 * @returns {{ reviewed: boolean, reason: string }}
 */
export function coverageFromReport(events) {
  const report = findReviewReport(events)
  if (report.seen !== true) return { reviewed: false, reason: 'no-report' }
  if (report.completed !== true) return { reviewed: false, reason: 'report-failed' }
  const list = Array.isArray(events) ? events : []
  const WRITE_TOOLS = new Set(['edit', 'write', 'multi_edit', 'apply_patch'])
  for (let i = report.index + 1; i < list.length; i += 1) {
    const event = list[i]
    const data = event && typeof event === 'object' ? event.data : undefined
    if (!data || typeof data !== 'object') continue
    if (event.type === 'tool/call' && WRITE_TOOLS.has(data.name)) {
      return { reviewed: false, reason: 'changed-after-report' }
    }
  }
  return { reviewed: true, reason: 'report-covers-diff' }
}
