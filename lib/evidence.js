/**
 * 取证层：把工作区的未提交改动收敛成一个快照。
 *
 * 两个输出用途不同，不能混：
 *  - files/added/removed  → 给 classifyTrigger 做规则判定
 *  - digest               → 做「评审后再改就重新拦」的新鲜度闸
 *
 * 为什么自己算 digest：第三方 code-review 插件的结果里虽然声明了 fingerprint 字段，
 * 但实测它从未被赋值（只存在于 .d.ts 的类型声明）。拿一个永远 undefined 的字段判
 * 「评审是否覆盖当前 diff」，等于没判。所以这里独立算。
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const GIT_ARGS = ['--no-optional-locks', '-c', 'core.quotepath=false'];

/** 取某个目录所在 git 仓库/工作树的 toplevel；不是仓库或失败时返回 undefined。 */
export async function gitRootOf(cwd, deps = {}) {
  const run = deps.runner ?? defaultRunner;
  if (typeof cwd !== 'string' || cwd.trim() === '') return undefined;
  try {
    const out = await run('git', [...GIT_ARGS, 'rev-parse', '--show-toplevel'], { cwd });
    const text = String(out ?? '').trim();
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

/** 可注入的 runner，单测不必真的跑 git。 */
export async function defaultRunner(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, { ...opts, timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: !error, stdout: typeof stdout === 'string' ? stdout : '' });
    });
  });
}

/**
 * 解析 `git diff --unified=0` 的正文，得到每个文件的增删行。
 *
 * 必须按 `diff --git` 分块解析，不能靠流式状态机：`new file mode` / `deleted file mode`
 * 出现在 `+++` **之前**，流式写法会在 cur 还没建立时把状态丢掉；删除文件更是整条
 * 因为 `+++ /dev/null` 而没有落点。这两种都会让门禁对「新增/删除文件」失明。
 */
export function parseUnifiedDiff(text) {
  const files = [];
  const blocks = String(text ?? '').split(/^diff --git /m).slice(1);

  for (const block of blocks) {
    const lines = block.split('\n');
    const header = lines[0] ?? '';

    let status = 'M';
    let path = null;
    let prevPath = null;

    for (const line of lines) {
      if (line.startsWith('new file mode')) status = 'A';
      else if (line.startsWith('deleted file mode')) status = 'D';
      else if (line.startsWith('rename from')) {
        status = 'R';
        prevPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to')) {
        status = 'R';
        path = line.slice('rename to '.length).trim();
      } else if (line.startsWith('+++ ')) {
        const p = line.slice(4).trim();
        if (p !== '/dev/null') path = p.replace(/^b\//, '');
      } else if (line.startsWith('--- ')) {
        const p = line.slice(4).trim();
        if (p !== '/dev/null' && !prevPath) prevPath = p.replace(/^a\//, '');
      }
    }

    if (!path) path = prevPath; // 删除文件：+++ 是 /dev/null，路径只存在于 --- 侧
    if (!path) {
      // 退化：从 "a/x b/y" 首行取（status D 取 a 侧，否则取 b 侧）
      const m = header.match(/^a\/(.*?) b\/(.*)$/);
      if (m) path = status === 'D' ? m[1] : m[2];
    }
    if (!path) continue;

    const added = [];
    const removed = [];
    let inHunk = false;
    for (const line of lines) {
      if (line.startsWith('@@')) { inHunk = true; continue; }
      if (!inHunk) continue;
      if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
      if (line.startsWith('+')) added.push(line.slice(1));
      else if (line.startsWith('-')) removed.push(line.slice(1));
    }

    files.push({
      path,
      status,
      added,
      removed,
      ...(prevPath && prevPath !== path ? { previousPath: prevPath } : {}),
    });
  }
  return files;
}

/** 把快照归一化成稳定文本再取 hash —— 只依赖内容，不依赖时间/顺序。 */
export function digestOf(files, untracked) {
  const norm = files
    .map((f) => `${f.status}\u0000${f.path}\u0000${(f.added ?? []).join('\u0001')}\u0000${(f.removed ?? []).join('\u0001')}`)
    .sort()
    .join('\u0002');
  const extra = (untracked ?? []).map((u) => `${u.path}\u0000${u.content}`).sort().join('\u0002');
  return createHash('sha256').update(`${norm}\u0003${extra}`).digest('hex');
}

/**
 * 采集当前工作区改动。
 * 任何一步失败都返回 { available:false }，由上层按 fail-open 处理。
 */
export async function collectDiff(cwd, deps = {}) {
  const run = deps.runner ?? defaultRunner;
  const readFileImpl = deps.readFile ?? readFile;
  const unavailable = { available: false, files: [], totals: { added: 0, removed: 0 }, digest: '', reason: '' };

  if (typeof cwd !== 'string' || cwd.trim() === '') {
    return { ...unavailable, reason: 'no cwd' };
  }

  // 1) 是否 git 仓库
  const inside = await run('git', [...GIT_ARGS, 'rev-parse', '--is-inside-work-tree'], { cwd });
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { ...unavailable, reason: 'not a git work tree' };
  }

  // 2) 已跟踪文件的改动
  const diff = await run('git', [...GIT_ARGS, 'diff', '--unified=0', 'HEAD'], { cwd });
  if (!diff.ok) return { ...unavailable, reason: 'git diff failed' };
  const tracked = parseUnifiedDiff(diff.stdout);

  // 3) 未跟踪的新文件（git diff 看不到，必须单独补，否则新建文件对门禁不可见）
  const untracked = [];
  const lsOther = await run('git', [...GIT_ARGS, 'ls-files', '-o', '--exclude-standard'], { cwd });
  if (lsOther.ok) {
    for (const raw of lsOther.stdout.split('\n')) {
      const rel = raw.trim();
      if (!rel) continue;
      let content = '';
      try {
        content = await readFileImpl(path.join(cwd, rel), 'utf8');
      } catch {
        continue; // 目录 / 读不了 → 不计入
      }
      const lines = content.split('\n');
      if (lines.length > 4000) lines.length = 4000; // 防御超大文件
      untracked.push({ path: rel, status: 'A', added: lines, removed: [] });
      tracked.push({ path: rel, status: 'A', added: lines, removed: [] });
    }
  }

  const files = tracked;
  const totals = files.reduce(
    (acc, f) => ({ added: acc.added + (f.added?.length ?? 0), removed: acc.removed + (f.removed?.length ?? 0) }),
    { added: 0, removed: 0 },
  );

  return {
    available: true,
    files,
    totals,
    digest: digestOf(files, untracked),
    reason: '',
  };
}
