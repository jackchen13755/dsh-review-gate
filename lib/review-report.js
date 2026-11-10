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

/**
 * 真实会话事件里，报告注入有两种承载形状（实测 2026-11-10）：
 *   ① 会话事件：{ type:'user/message', data:{ content:[...], source:{kind} } }
 *   ② 消息对象：{ type:'user/message', data:{ message:{ content:[...], source:{kind} } } }
 * 只认 ② 是之前的真 bug：生产里是 ①，于是「评审已完成的报告」永远识别不到，
 * 门禁每回合都以为没评审 → 反复自动 /review（实测一个会话连发 5 次）。
 */
function candidatesOf(event) {
  const data = event && typeof event === 'object' ? event.data : undefined
  if (data === null || typeof data !== 'object') return []
  const out = []
  if (data.message !== null && typeof data.message === 'object') out.push(data.message)
  if (data.source !== null && typeof data.source === 'object') out.push(data)
  return out
}

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
    for (const message of candidatesOf(list[i])) {
      const source = message.source
      if (source === null || typeof source !== 'object') continue
      if (source.kind !== REPORT_SOURCE_KIND) continue
      if (message.role !== undefined && message.role !== 'user') continue
      const text = textOf(message)
      // 文本读不出来时不能当成功：宁可当作「未识别」，也不要谎报已评审。
      const completed = text.startsWith(COMPLETED_PREFIX)
      return { seen: true, completed, failed: !completed || text.startsWith(FAILED_PREFIX), index: i }
    }
  }
  return { seen: false, completed: false, failed: false, index: -1 }
}

/**
 * 报告是否覆盖当前 diff。
 *
 * 判据：**最后一次写文件之后，是否出现过一次成功的评审报告**。
 *
 * 为什么不能只看最后一条报告（2026-11-10 实测的坑）：同一版 diff 可能被反复评审，
 * 后面几次失败（超时/中止），最后一条是失败报告——但 diff 自那次成功报告之后根本没变，
 * 它仍然是被覆盖的。只看最后一条会把这种情况判成「未评审」，于是又触发一次评审，
 * 越失败越重试（实测一个会话连评 5 次）。
 *
 * @param {any[]} events
 * @returns {{ reviewed: boolean, reason: string }}
 */
export function coverageFromReport(events) {
  const list = Array.isArray(events) ? events : []
  const WRITE_TOOLS = new Set(['edit', 'write', 'multi_edit', 'apply_patch'])

  let lastWrite = -1
  const reports = []
  for (let i = 0; i < list.length; i += 1) {
    const event = list[i]
    const data = event && typeof event === 'object' ? event.data : undefined
    if (!data || typeof data !== 'object') continue
    if (event.type === 'tool/call' && WRITE_TOOLS.has(data.name)) lastWrite = i
    for (const message of candidatesOf(event)) {
      const source = message.source
      if (source === null || typeof source !== 'object') continue
      if (source.kind !== REPORT_SOURCE_KIND) continue
      if (message.role !== undefined && message.role !== 'user') continue
      reports.push({ index: i, completed: textOf(message).startsWith(COMPLETED_PREFIX) })
    }
  }

  if (reports.length === 0) return { reviewed: false, reason: 'no-report' }
  // 最后一次写之后出现过成功报告 → 覆盖当前 diff。
  const afterWrite = reports.filter((r) => r.index > lastWrite)
  if (afterWrite.some((r) => r.completed)) return { reviewed: true, reason: 'report-covers-diff' }
  if (afterWrite.length > 0) return { reviewed: false, reason: 'report-failed' }
  return { reviewed: false, reason: 'changed-after-report' }
}
