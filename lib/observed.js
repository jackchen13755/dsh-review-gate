/**
 * 降级取证层：当工作目录不是 git 仓库（或 git 取不到 diff）时，
 * 改用「本会话实际写过的文件」来判定。
 *
 * 为什么需要它：门禁只在 git 仓库里生效，意味着在「多个独立仓库的父目录」
 * 里（例如 ~/Desktop/dsh/github）永远不工作——而那恰恰是最常用的目录之一。
 * 之前的表现是静默 fail-open，用户无法区分「按设计放行」和「插件坏了」。
 *
 * 精度取舍（必须如实说清）：
 *  - ✅ 可以判：配置/契约类文件、安全敏感路径、跨模块——这些只看路径。
 *  - ✅ 可以做新鲜度：读文件内容算摘要，所以「评审后又改同一文件」能识别。
 *  - ❌ 不能判：判定表达式、公共 API、删除量、总规模——这些需要 diff 的增删行。
 * 所以 partial=true 时只启用路径类规则，避免把「文件里本来就有 if(」误判成本轮引入了判定。
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { existsSync } from 'node:fs';

import { capSet, LIMITS } from './bounded.js';

/** sessionId → Map<路径, {created}>，只记本会话写过的文件。 */
const observed = new Map();
/** sessionId → 自上次写入以来经过的 pre-step 次数（判断 agent 是否还在行动中）。 */
const quietSteps = new Map();
/**
 * 写入后至少经过这么多步才允许 pre-step 介入。
 *
 * 为什么是 6 而不是 2：实机测过 2 会误伤——agent 的正常节奏是
 * `edit → bash 自查 → review_gate_status → dsh_code_review`，
 * 隔两步才调评审，阈值 2 正好撞上，反而制造了它本想避免的那次返工。
 *
 * 定位纠正：pre-step 只该覆盖「回合永不结束 / 被中断」这种极端情况，
 * 正常收尾由 turn-stopping 负责。所以窗口要给得足够宽，宁可漏，不抢戏。
 */
export const QUIET_STEPS_BEFORE_GATE = 6;

/**
 * 解析会话标识。`tools/execute` 与 `agent/turn-stopping` 拿到的对象形状不同
 * （前者可能挂在 execution.agent/execution.session 下），但必须解析出同一个 key，
 * 否则「记录观察」和「读取观察」会对不上，降级取证静默失效。
 * 权威顺序与 lint-guard 的 ownerFromSession 一致：session.id → session.header.id → agent.id。
 */
export function resolveSessionId(subject) {
  if (!subject || typeof subject !== 'object') return undefined;
  const session = subject.session
    ?? (subject.agent && typeof subject.agent === 'object' ? subject.agent.session : undefined);
  if (session && typeof session === 'object') {
    if (typeof session.id === 'string' && session.id !== '') return session.id;
    if (session.header && typeof session.header.id === 'string' && session.header.id !== '') return session.header.id;
  }
  const agent = subject.agent && typeof subject.agent === 'object' ? subject.agent : subject;
  if (typeof agent.id === 'string' && agent.id !== '') return agent.id;
  return undefined;
}

/** 单文件读取上限：超过就只按路径判，不读内容（防止大文件拖慢 turn-stopping）。 */
const MAX_FILE_BYTES = 256 * 1024;

function setFor(sid) {
  let s = observed.get(sid);
  if (!s) {
    s = new Map();
    observed.set(sid, s);
  }
  return s;
}

/** 记录一次成功的写操作。同步、永不抛。 */
export function recordWrite(sessionId, filePath, meta) {
  try {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    if (typeof filePath !== 'string' || filePath.trim() === '') return;
    const m = setFor(sessionId);
    const key = filePath.trim();
    // created 必须在**写入之前**判定并由调用方传进来。
    // 若在这里（写入之后）检查文件是否存在，新建的文件必然已存在 → 永远判不出新增。
    const created = meta?.created === true;
    // 键序必须是 LRU → MRU（最后一个 = 最近写入），因为 repoRootsFromObserved 靠它
    // 判断「此刻在改哪个仓库」。而 `Map#set` 对**已存在的键不会移动位置**：不先删，
    // 反复修改同一个文件就永远不刷新位置，键序退化成「首次写入顺序」，
    // 多仓库会话里于是审到最先改的那个仓库而不是正在改的。
    const previous = m.get(key);
    if (previous) m.delete(key);
    // 保留历史 created：同一会话里这文件曾被判「新增」，后续再改它不该丢掉该事实。
    m.set(key, { created: created || previous?.created === true });
    // 每次写入都把「安静步数」归零：pre-step 只有在写入后过了若干步、
    // agent 仍在收尾却没评审时才该介入。否则会在 agent 正要调评审的
    // 那一刻抢先拦下，反而制造它本想避免的那次返工。
    quietSteps.set(sessionId, 0);
    while (m.size > LIMITS.pathsPerSession) {
      const oldest = m.keys().next();
      if (oldest.done) break;
      m.delete(oldest.value);
    }
  } catch {
    // 观察钩子必须无副作用失败
  }
}

/** 观察到的路径，顺序为 LRU → MRU（末尾是最新写入的）。 */
export function observedPaths(sessionId) {
  const s = observed.get(sessionId);
  return s ? [...s.keys()] : [];
}

/** 最近写入的那个路径；没有观察记录时为 undefined。 */
export function latestObservedPath(sessionId) {
  const s = observed.get(sessionId);
  if (!s || s.size === 0) return undefined;
  let last;
  for (const k of s.keys()) last = k;
  return last;
}

export function clearObserved(sessionId) {
  if (sessionId === undefined) { observed.clear(); quietSteps.clear(); }
  else { observed.delete(sessionId); quietSteps.delete(sessionId); }
}

/** pre-step 每次调用推进一格，返回推进后的计数。 */
export function bumpQuietStep(sessionId) {
  const n = (quietSteps.get(sessionId) ?? 0) + 1;
  quietSteps.set(sessionId, n);
  return n;
}

/** 当前安静步数（0 = 刚写完文件）。 */
export function quietStepOf(sessionId) {
  return quietSteps.get(sessionId) ?? 0;
}

/**
 * 把观察到的路径收敛成一个「部分快照」。
 * files[].added 故意留空——这样 classifyTrigger 里依赖 diff 内容的规则自然不触发。
 */
export async function observedSnapshot(sessionId, deps = {}) {
  const readFileImpl = deps.readFile ?? readFile;
  const existsImpl2 = deps.exists ?? ((q) => Promise.resolve(existsSync(q)));
  const cwd = typeof deps.cwd === 'string' && deps.cwd !== '' ? deps.cwd : undefined;
  const paths = observedPaths(sessionId);
  if (paths.length === 0) {
    return { available: false, reason: 'no observed writes', partial: true, files: [], totals: { added: 0, removed: 0 }, digest: '' };
  }

  /**
   * 判定用的路径必须是「相对 cwd」的，否则绝对路径的首段永远是同一级（如 /Users），
   * 跨模块规则会恒为 false。git 模式给的本来就是仓库相对路径，这里对齐语义。
   */
  const display = (p) => {
    if (!cwd) return p;
    try {
      const rel = path.relative(cwd, p);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
    } catch {
      // 落到绝对路径
    }
    return p;
  };

  const metaMap = observed.get(sessionId) ?? new Map();
  const parts = [];
  const files = [];
  for (const p of paths) {
    let content = '';
    try {
      content = await readFileImpl(p, 'utf8');
      if (content.length > MAX_FILE_BYTES) content = content.slice(0, MAX_FILE_BYTES);
    } catch {
      content = '';
    }
    parts.push(`${p}\u0000${content}`);
    // A=写入前不存在（本次新建）→ structural 能触发；M=本来就有
    const created = metaMap.get(p)?.created === true;
    files.push({
      path: display(p),
      absPath: p,
      status: created ? 'A' : 'M',
      added: [],
      removed: [],
    });
  }

  return {
    available: true,
    partial: true,
    source: 'session',
    files,
    totals: { added: 0, removed: 0 },
    digest: createHash('sha256').update(parts.sort().join('\u0002')).digest('hex'),
    reason: '',
  };
}

/** 从某个路径向上找包含 .git 的祖先目录。 */
async function rootOfPath(p, existsImpl) {
  let dir = p;
  // 文件路径 → 所在目录；目录则自身
  for (let i = 0; i < 12; i += 1) {
    const candidate = path.join(dir, '.git');
    try {
      if (await existsImpl(candidate)) return dir;
    } catch {
      // 继续向上
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * 从「本会话写过的文件路径」反推仓库根，**返回全部**，最近写入的排最前。
 *
 * 为什么需要：会话 cwd 未必是 git 仓库（例如会话 cwd 是多个独立仓库的父目录，
 * 而改动落在其下的某个仓库里）。此时用 cwd 跑 git 会得到 not a git work tree，
 * 于是只能返回「拿不到改动」——等于什么也没审。
 *
 * 为什么是「全部」而不是「一个」：一个工作区根下常有多个独立仓库（本机实测 21 个），
 * 同一会话完全可能同时改两个。只返回一个根 = **静默漏审**另一个，且用户无法察觉。
 * 调用方拿到列表后，才能明确回答「这次改的是哪个项目」，而不是随便挑一个。
 */
export async function repoRootsFromObserved(sessionId, deps = {}) {
  const existsImpl = deps.exists ?? ((p) => Promise.resolve(existsSync(p)));
  const paths = observedPaths(sessionId);
  const roots = [];
  const seen = new Set();
  // 逆序 = MRU → LRU：保证「此刻正在改的仓库」排第一。
  for (let i = paths.length - 1; i >= 0; i -= 1) {
    const root = await rootOfPath(paths[i], existsImpl);
    if (!root || seen.has(root)) continue;
    seen.add(root);
    roots.push(root);
  }
  return roots;
}

/**
 * 兼容入口：本会话最可能在改的那个仓库根（= 最近写入文件所属的仓库）。
 *
 * 早期实现按插入序取第一个，等价于「最先改的仓库」，多仓库会话里会审错树
 * （2026-11-11 修正）。要判断是否跨仓库，直接用 repoRootsFromObserved 拿全量。
 */
export async function repoRootFromObserved(sessionId, deps = {}) {
  const roots = await repoRootsFromObserved(sessionId, deps);
  return roots[0];
}
