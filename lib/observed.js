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

/** sessionId → Set<路径>，只记本会话写过的文件，回合结束不清（跨回合可累积）。 */
const observed = new Map();

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
    // created 必须在**写入之前**判定并由调用方传进来。
    // 若在这里（写入之后）检查文件是否存在，新建的文件必然已存在 → 永远判不出新增。
    m.set(filePath.trim(), { created: meta?.created === true });
    while (m.size > LIMITS.pathsPerSession) {
      const oldest = m.keys().next();
      if (oldest.done) break;
      m.delete(oldest.value);
    }
  } catch {
    // 观察钩子必须无副作用失败
  }
}

export function observedPaths(sessionId) {
  const s = observed.get(sessionId);
  return s ? [...s.keys()] : [];
}

export function clearObserved(sessionId) {
  if (sessionId === undefined) observed.clear();
  else observed.delete(sessionId);
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

/**
 * 从「本会话写过的文件路径」反推仓库根。
 *
 * 为什么需要：会话 cwd 未必是 git 仓库（例如本次会话的 cwd 是 plugins 父目录，
 * 而改动落在其下的某个独立仓库里）。此时用 cwd 跑 git 会得到 not a git work tree，
 * 于是 review_brief 只能返回「拿不到改动」——等于什么也没审。
 *
 * 做法：对每个观察到的路径，从它所在目录向上找 .git，找到即返回。
 */
export async function repoRootFromObserved(sessionId, deps = {}) {
  const existsImpl = deps.exists ?? ((p) => Promise.resolve(existsSync(p)));
  const paths = observedPaths(sessionId);
  for (const p of paths) {
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
  }
  return undefined;
}
