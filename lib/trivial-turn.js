/**
 * 「运维回合」判定：只做了提交/推送/打 tag 这类操作、没有实质改动工作树的回合，不评审。
 *
 * 为什么需要：`git commit` 会把之前改好的文件带进 diff（例如 package.json），
 * 触发规则只看 diff，于是“我只是推了一下”也会被要求评审——白烧一次评审。
 *
 * 判定口径（**保守：宁可多评一次，不可漏审一次**）：
 *   1. 本回合没有任何写文件工具（edit / write / multi_edit / apply_patch）；
 *   2. 本回合所有 bash 片段都不含「写意图」（重定向、tee、xargs、-exec、-delete、
 *      sed -i、sort -o、mv/cp/rm/touch/mkdir/chmod/ln/truncate/dd 等）；
 *   3. 每个片段要么是 git 运维子命令，要么是只读命令；
 *   4. 没有出现未知工具（未知 = 不判为运维）。
 *
 * 2026-11-11 修正的两类错误（都实测过，见 tests）：
 *
 *  A. **漏审（危险方向）**：早期把 echo/cat/ls/find/rg/sort 一律当只读，于是
 *     `echo x > lib/a.js`、`ls > f`、`find . -delete`、`find -exec sed -i`、
 *     `rg foo | xargs sed -i`、`sort -o f` 全部被判「免评审」——真的改了工作树
 *     却不评审，而且用户看不到任何提示。现在改为检测「写意图」，
 *     这些命令只要带写意图就不算运维。
 *
 *  B. **误审（噪音方向）**：早期按裸分隔符切分、不看引号，于是
 *     `git commit -m "fix: a; b"` 被切成两段、第二段判定失败 → 白审一次；
 *     `git -C <path> commit` 也因为前缀不是 `git ` 直接子命令而判失败。
 *     现在分隔符切分引号感知，且允许 git 的全局选项前缀。
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

/**
 * git 运维子命令白名单。
 *
 * 允许任意多个全局选项前缀（`-C <path>`、`-c k=v`、`--git-dir=…`、`--no-pager` 等），
 * 否则 `git -C /repo commit` 这种最普通的写法会被判成非运维、白审一次。
 *
 * 为什么把 merge / rebase / cherry-pick / revert 也算运维（用户明确要求
 * 「合并无冲突时不用调评审」）：**真有冲突时它们必然伴随 edit 调用**——冲突标记
 * 只能靠改文件解决，而 edit 会走 has-writes 分支强制评审。于是
 * 「无冲突合并免评审、有冲突合并必评审」由结构自然保证，不必去猜 diff 内容。
 */
const GIT_OPS = /^git(?:\s+(?:-C|-c|--git-dir|--work-tree|--namespace|--no-pager|--paginate)(?:=\S+|\s+\S+))*\s+(add|commit|push|pull|fetch|tag|status|log|diff|show|branch|checkout|switch|stash|remote|rev-parse|ls-files|merge|rebase|cherry-pick|revert)\b/

/** 只读的其它命令（读文件、查状态）。 */
const SAFE_CMDS = /^(ls|cat|pwd|echo|wc|rg|grep|find|head|tail|sort|uniq|test|true|node --version)\b/

/**
 * 「写意图」信号：只要出现就不算运维回合。
 *
 * 这些是**保守**判据：命中即要求评审。宁可多审一次，也不接受「真的改了文件却免评审」——
 * 后者是静默漏审，用户无从察觉；前者只是多花一次评审。
 */
const WRITE_INTENT = [
  // 文件重定向。排除 `2>&1` 这类描述符重定向（`>` 紧跟 `&`）。
  />>?(?!&)/,
  // 喂养给后续命令的执行器（`rg x | xargs sed -i`）。
  /(^|[\s|;])xargs\b/,
  // find 的写操作。
  /(^|\s)(-exec|--exec|-delete|-ok)(\s|$)/,
  // sed 原地改。
  /\bsed\b[^\n]*?\s-i(\s|$|[.'"])/,
  // sort 输出到文件。
  /\bsort\b[^\n]*?\s-o\s/,
  // 直接改动文件系统的命令。
  /(^|[\s|;&])(mv|cp|rm|rmdir|touch|mkdir|chmod|chown|ln|truncate|dd|tee|patch|install)\b/,
]

/** 运维回合里允许出现的复合命令片段分隔。 */
function segmentsOf(command) {
  const text = String(command ?? '')
  const out = []
  let buf = ''
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      buf += ch
      // 只认未被转义的闭合引号
      if (ch === quote && text[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buf += ch
      continue
    }
    if (ch === '&' && text[i + 1] === '&') { out.push(buf); buf = ''; i += 1; continue }
    if (ch === '|' && text[i + 1] === '|') { out.push(buf); buf = ''; i += 1; continue }
    // 单个 `|` 也要切：管道右侧可能才是写文件的那一段
    if (ch === ';' || ch === '\n' || ch === '|') { out.push(buf); buf = ''; continue }
    buf += ch
  }
  out.push(buf)
  return out.map((part) => part.trim()).filter((part) => part !== '')
}

function hasWriteIntent(command) {
  const text = String(command ?? '')
  // 引号内的 `>` 不构成重定向（`git commit -m "a > b"`）。
  const unquoted = text.replace(/"[^"]*"|'[^']*'/g, '""')
  return WRITE_INTENT.some((pattern) => pattern.test(unquoted))
}

function isOpsCommand(command) {
  if (hasWriteIntent(command)) return false
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
      if (typeof command !== 'string') return { trivial: false, reason: 'bash-non-ops' }
      if (hasWriteIntent(command)) return { trivial: false, reason: 'bash-write-intent' }
      if (!isOpsCommand(command)) return { trivial: false, reason: 'bash-non-ops' }
    }
  }
  if (calls === 0) return { trivial: false, reason: 'no-tool-calls' }
  return { trivial: true, reason: 'ops-only' }
}
