/**
 * 复审范围收窄（R16）：评审发现问题 → agent 修改 → 再次评审**只针对问题**，不全量重审。
 *
 * 为什么需要：一次评审往往覆盖几十个文件，评审后 agent 只按报告改了 1–2 个文件；
 * 若再次全量评审，额度花在已经审过、且一个字都没变的文件上，报告也会被旧内容淹没，
 * 真正要复核的那几行反而被埋掉。
 *
 * 判定口径（按文件签名，不按整份 diff 摘要）：
 *   签名 = path + added + removed 拼接。只看内容，不看 status：
 *   同一个文件从 M 变成 A（例如被 `git add`）内容没变时，不需要再评审。
 *
 * 为什么不直接用 diff.digest：digest 混入了 untracked 快照与 status，
 * 它回答的是「是不是同一版改动」；复审要回答的是「哪几个文件变了」，digest 答不了。
 *
 * 纯函数：不读盘、不抛错。上一份快照缺失/损坏时一律退化为全量——宁可多审一次，
 * 也不接受「因为没有基线所以声称没有改动」（那会静默漏审）。
 */

/** 只接受带非空字符串 path 的文件项；其它形状一律视为无效（脏输入不抛）。 */
function hasPath(file) {
  return Boolean(file) && typeof file === 'object' && typeof file.path === 'string' && file.path !== ''
}

/** 行数组归一成字符串数组：added/removed 不是数组（脏输入）时按空处理。 */
function linesOf(value) {
  return Array.isArray(value) ? value.map((line) => String(line)) : []
}

/** 文件签名：内容相同即视为同一份，与顺序无关以外的字段（status）不参与。 */
function signatureOf(file) {
  return `${file.path}\u0000${linesOf(file.added).join('\u0001')}\u0000${linesOf(file.removed).join('\u0001')}`
}

/**
 * 取出 diff 里的文件数组；非对象 / files 非数组 → undefined（区别于「空数组」）。
 * @returns {any[]|undefined}
 */
function filesOf(diff) {
  if (diff === null || typeof diff !== 'object') return undefined
  return Array.isArray(diff.files) ? diff.files : undefined
}

/**
 * 计算本次复审应收窄到哪些文件。
 *
 * @param {{ files?: Array<{path?: string, status?: string, added?: string[], removed?: string[]}> }|undefined|null} previous
 *   上一次**成功评审**时的 diff 快照（gate 里的 reviewBasis）
 * @param {{ files?: Array<{path?: string, status?: string, added?: string[], removed?: string[]}> }|undefined|null} current
 *   本次判定看到的 diff（collectDiff 的形状）
 * @returns {{ mode: 'full'|'narrow', files: string[], reason: 'no-previous'|'unchanged'|'changed' }}
 *   full     —— 没有可用的基线（previous 缺失、files 非数组或为空），只能全量评审；
 *               此时 files 恒为空数组，调用方不要把它读成「没有文件要审」。
 *   narrow   —— 有基线：files 为自上次评审以来新增/内容变化/被删掉的文件（字典序）；
 *               files 为空表示一个文件都没变（reason='unchanged'）。
 */
export function deltaScope(previous, current) {
  const previousFiles = filesOf(previous)
  const previousValid = (previousFiles ?? []).filter(hasPath)
  // 没有基线就收窄不了：空快照 / files 非数组 / 全部元素缺 path 都算「没有基线」。
  // 不能把它当成「上一版什么都没有」——那样每个文件都会被算成新增，
  // hint 会说「变更了全部文件」，等于把「不知道」说成「全都变了」。
  if (previousFiles === undefined || previousValid.length === 0) {
    return { mode: 'full', files: [], reason: 'no-previous' }
  }

  const currentValid = (filesOf(current) ?? []).filter(hasPath)
  const previousByPath = new Map(previousValid.map((file) => [file.path, signatureOf(file)]))
  const currentByPath = new Map(currentValid.map((file) => [file.path, signatureOf(file)]))

  const changed = new Set()
  for (const [path, signature] of currentByPath) {
    // 基线里没有 = 新增；签名不同 = 内容变了
    if (!previousByPath.has(path) || previousByPath.get(path) !== signature) changed.add(path)
  }
  for (const path of previousByPath.keys()) {
    // 基线里有、这次没有 = 被删掉，或改动被改回去了：两种都必须复审
    if (!currentByPath.has(path)) changed.add(path)
  }

  const files = [...changed].sort()
  if (files.length === 0) return { mode: 'narrow', files: [], reason: 'unchanged' }
  return { mode: 'narrow', files, reason: 'changed' }
}
