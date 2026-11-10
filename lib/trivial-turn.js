/**
 * 「运维回合」判定：只做了提交/推送/打 tag 这类操作，没有实质代码改动的回合，不评审。
 *
 * 为什么需要：`git commit` 会把之前改好的文件带进 diff（例如 package.json），
 * 触发规则只看 diff，于是“我只是推了一下”也会被要求评审——白烧一次评审。
 *
 * 判定口径（保守，宁可多评一次）：
 *   1. 本回合没有任何写文件工具（edit / write / multi_edit / apply_patch）；
 *   2. 本回合所有 bash 命令都属于运维白名单（git add/commit/push/…）；
 *   3. 没有出现未知工具（未知 = 不判为运维）。
 *
 * 纯函数，便于喂边界输入单测。
 */

/** 写文件的工具：出现任何一个就不算运维回合。 */
const WRITE_TOOLS = new Set(['edit', 'write', 'multi_edit', 'apply_patch'])

/** 允许出现在运维回合里的只读/协作工具。 */
const HARMLESS_TOOLS = new Set([
  'read',
  'lens',
  'skill',
  'todo_write',
  'compress',
  'ask_user_question',
  'validate_dsh_ui',
  'working_directory',
  'job_output',
  'mem_search',
  'mem_get',
  'mem_write',
  'mem_todo',
  'ledger_open',
  'ledger_evidence',
  'ledger_check',
  'ledger_status',
  'bash',
])

/** git 子命令白名单（运维动作）。 */
const GIT_OPS = /^git\s+(add|commit|push|pull|fetch|tag|status|log|diff|show|branch|checkout|switch|stash|remote|rev-parse|ls-files)\b/

/** 只读的其它命令（读文件、查状态）。 */
const SAFE_CMDS = /^(ls|cat|pwd|echo|wc|rg|grep|find|head|tail|sort|uniq|test|true|node --version)\b/

/** 运维回合里允许出现的复合命令片段分隔。 */
function segmentsOf(command) {
  return String(command)
    .split(/\s*(?:&&|\|\||;|\n)\s*/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

function isOpsCommand(command) {
  const segments = segmentsOf(command)
  if (segments.length === 0) return true
  return segments.every((seg) => GIT_OPS.test(seg) || SAFE_CMDS.test(seg))
}

function argsOf(data) {
  const raw = data?.arguments
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }
  return raw !== null && typeof raw === 'object' ? raw : {}
}

/**
 * @param {any[]} events 会话事件
 * @param {{ turn?: number }} opts turn 为 number 时只看该回合，否则看全部
 * @returns {{ trivial: boolean, reason: string }}
 */
export function classifyTurn(events, opts = {}) {
  const list = Array.isArray(events) ? events : []
  const wantTurn = typeof opts.turn === 'number' ? opts.turn : undefined

  let calls = 0
  for (const event of list) {
    if (event === null || typeof event !== 'object' || event.type !== 'tool/call') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    if (wantTurn !== undefined && data.turn !== wantTurn) continue
    calls += 1
    const name = data.name
    if (WRITE_TOOLS.has(name)) return { trivial: false, reason: 'has-writes' }
    if (!HARMLESS_TOOLS.has(name)) return { trivial: false, reason: `unknown-tool:${String(name)}` }
    if (name === 'bash') {
      const command = argsOf(data).command
      if (typeof command !== 'string' || !isOpsCommand(command)) return { trivial: false, reason: 'bash-non-ops' }
    }
  }
  if (calls === 0) return { trivial: false, reason: 'no-tool-calls' }
  return { trivial: true, reason: 'ops-only' }
}
