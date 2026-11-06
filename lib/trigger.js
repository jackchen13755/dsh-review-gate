/**
 * 判定层：这批改动该不该触发评审。
 *
 * 纯函数——不读文件、不跑 git、不碰任何 IO。这样做的原因是历史教训而不是洁癖：
 * 判定逻辑一旦内联进框架闭包，外部就无法 require，作者只能拿「构建通过 / 体积下降」
 * 这类产物级信号自证，而「真实数据没覆盖到的那一格算错」永远暴露不出来。
 * 所以判定本体必须能被外部直接调用，并允许喂合成输入逐条验边界。
 *
 * @typedef {{ path: string, status?: 'A'|'M'|'D'|'R', added?: string[], removed?: string[] }} ChangedFile
 * @typedef {{ available: boolean, files?: ChangedFile[], totals?: { added?: number, removed?: number } }} DiffSnapshot
 */

/** 触发原因枚举。字符串直接进 steer 文本，改词要同步改测试。 */
export const REASONS = Object.freeze({
  CONFIG: 'config',
  DECISION: 'decision',
  CROSS_MODULE: 'cross-module',
  SECURITY: 'security',
  PUBLIC_API: 'public-api',
  DELETION: 'deletion',
  VOLUME: 'volume',
  /**
   * 兜底：改动里出现了非注释的代码变更。
   *
   * 上面七条都是「特别值得警惕」的规则，但不命中的小改动同样会带着缺陷进场。
   * 实测反馈（session-c862e3b5）：只改一两行的回合门禁一声不响，只能手动开评审。
   * 规则越精确 → 漏得越多；这条把「精确」让给清单，把「不漏」交给兜底。
   * 可用 reviewAnyCodeChange=0 关掉。
   */
  CODE: 'code',
  /**
   * 结构性改动：新增或删除代码文件（等于动了模块边界）。
   * 这一类除了代码评审，还要求跑一次 lens（影响面/循环依赖/耦合度）——
   * 因为「模块划分是否合理」读单个文件看不出来，只能从图上看。
   */
  STRUCTURAL: 'structural',
});

/** 代码文件扩展名（只有这些的增删才算「动了模块边界」）。 */
const CODE_EXT_RE = /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts|vue|svelte|py|go|rs|java|kt|swift|rb|php)$/i;

/** 配置 / 契约类文件名（只看 basename，精确匹配）。 */
const CONFIG_BASENAMES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'Dockerfile',
  'Makefile',
  'cordis.patch.yml',
  'cordis.yml',
  'biome.json',
  'biome.jsonc',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.prettierrc',
  '.npmrc',
  '.nvmrc',
  '.browserslistrc',
  'tsconfig.json',
  'vitest.config.ts',
  'vitest.config.js',
]);

/**
 * 锁文件：机器生成、内容由包管理器决定，人看也没意义 → 永不计入。
 * 单独成集合是因为它们的扩展名各式各样（.yaml / .json / .lock / .sum），
 * 单靠扩展名规则会把 pnpm-lock.yaml 误判成「契约文件」。
 */
const LOCKFILE_BASENAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-lock.yml',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'Cargo.lock',
  'poetry.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
  'Pipfile.lock',
  'flake.lock',
]);

/** 配置 / 契约类文件名模式（basename 正则）。 */
const CONFIG_BASENAME_RES = [
  /^tsconfig\..*\.json$/,
  /^.*\.config\.(js|mjs|cjs|ts|mts|cts)$/,
  /^docker-compose.*\.ya?ml$/,
  /^\.env(\..*)?$/,
];

/**
 * 根级 / 基建目录下的 yml / json 也算契约（KD8s、CI、流水线都藏在这里）。
 * 用目录段判定而不是全仓 yml，避免把随手写的 data.yml 也算进来。
 */
const INFRA_DIR_SEGS = new Set([
  '.github',
  '.gitlab',
  '.gitlab-ci',
  'k8s',
  'helm',
  'charts',
  'ci',
  'deploy',
  'deployment',
  '.circleci',
]);

/** 判定表达式：命中即说明「这段改动在决定什么被归类/放行/分流」。 */
const DECISION_RE = /\.(every|some|filter|includes|match|test)\s*\(|new (Set|Map)\s*\(|\bif\s*\(|\bswitch\s*\(|^\s*case\b|\?\s*[^:?.]+\s*:\s*/;

/** 公共 API 签名变更。 */
const PUBLIC_API_RE = /^\s*export\s+(default\s+)?(declare\s+)?(async\s+)?(function|interface|type|const|let|class|enum|abstract\s+class)\b/;

/** 安全敏感路径。 */
const SECURITY_RE = /(^|\/)(auth|authz|oauth|secret|secrets|token|tokens|crypto|password|passwd|credential|credentials|permission|permissions|guard|acl|session)([\/._-]|$)/i;

/** 文档类扩展名（不含判定/API 时不算数）。 */
const DOC_RE = /\.(md|mdx|rst|txt|adoc)$/i;

/** 纯生成物 / 锁文件，永不计入。 */
const ARTIFACT_RE = /(^|\/)(node_modules|dist|build|out|coverage|\.next|vendor)\/|\.(lock|snap)$|(^|\/)(CHANGELOG|CHANGELOG\.md)$/i;

function basename(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

/** 路径的目录段（去掉文件名）。 */
function dirSegs(p) {
  const parts = p.split('/').filter(Boolean);
  parts.pop();
  return parts;
}

/** 极简 glob → RegExp：支持 `**`、`*`、`?`。够用且零依赖。 */
function globToRe(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

function matchesAny(path, patterns) {
  for (const g of patterns) {
    if (globToRe(g).test(path)) return true;
  }
  return false;
}

function isConfigFile(p) {
  const base = basename(p);
  if (CONFIG_BASENAMES.has(base)) return true;
  if (CONFIG_BASENAME_RES.some((re) => re.test(base))) return true;
  // 基建目录下的 yml / yaml / json
  if (/\.(ya?ml|json)$/i.test(base)) {
    const segs = dirSegs(p);
    if (segs.some((s) => INFRA_DIR_SEGS.has(s.toLowerCase()))) return true;
    if (segs.length === 0) return true; // 仓库根
  }
  return false;
}

/** 全部变更行都只是注释 / 空白（用来压掉纯排版改动）。 */
/**
 * 按文件类型决定「注释前缀」。
 *
 * 为什么不能一刀切把 `#` 当注释：JS/TS 的 `#privateField`、CSS 的 `#id` 选择器
 * 都以 `#` 开头，但它们是代码。一刀切会让这类改动被判成「纯注释」而静默放行
 * （实测：`  #cache = new Map();` 这种单行改动 trigger=false）。
 * 反过来，`.py`/`.sh`/`.yml` 里 `#` 确实是注释，不认它就会把注释改动当成代码。
 *
 * 未知扩展名一律按 C 系注释处理（不认 `#`）：宁可多拦一次评审核实，也不静默放过。
 */
const HASH_COMMENT_EXT = /\.(py|pyi|sh|bash|zsh|fish|yml|yaml|toml|rb|mk|pl|pm|r|ps1|cfg|ini|conf|properties|cmake)$/i;
const HASH_COMMENT_BASENAME = /(^|\/)(dockerfile|makefile|\.env[^/]*|\.gitignore|\.dockerignore)$/i;
const DOC_EXT = /\.(md|mdx|rst|txt|adoc)$/i;

function commentPrefixesFor(filePath) {
  const p = typeof filePath === 'string' ? filePath : '';
  if (DOC_EXT.test(p)) return ['#', '>', '<!--'];
  if (HASH_COMMENT_EXT.test(p) || HASH_COMMENT_BASENAME.test(p)) return ['#'];
  // 默认（js/ts/css/go/rs/java/…）：只认 C 系注释，`#` 是代码
  return ['//', '/*', '*', '*/'];
}

export function isCommentOnly(files) {
  for (const f of files) {
    const prefixes = commentPrefixesFor(f?.path);
    for (const raw of [...(f.added ?? []), ...(f.removed ?? [])]) {
      const t = String(raw).trim();
      if (t === '') continue;
      if (prefixes.some((p) => t.startsWith(p))) continue;
      return false;
    }
  }
  return true;
}

/**
 * 判定入口。
 *
 * @param {DiffSnapshot|undefined|null} snapshot
 * @param {{ ignoreGlobs?: string[], extraTriggerGlobs?: string[], thresholds?: { removal?: number, volume?: number } }} [opts]
 * @returns {{ trigger: boolean, reasons: string[], undetermined: boolean }}
 */
export function classifyTrigger(snapshot, opts = {}) {
  const err = { trigger: false, reasons: [], undetermined: false };

  // 取证失败（非 git 仓 / git 超时 / 没有 cwd）：如实标 undetermined 并放行。
  // 这条必须由测试钉住——门禁 fail-closed 会让这类机器永远无法收工，比漏检更糟。
  if (!snapshot || snapshot.available !== true) {
    return { ...err, undetermined: true };
  }

  // files 不是数组 = 取证结果畸形（读不到改动清单）。必须标 undetermined：
  // 否则「读不到」会被记成「确认没有改动」，门禁瞎了也没人能从状态里看出来。
  if (!Array.isArray(snapshot.files)) {
    return { ...err, undetermined: true };
  }
  const files = snapshot.files;
  // 空的改动清单是**已确定**的「没有改动」，与上面的「读不到」不同，按放行处理。
  if (files.length === 0) return err;

  const ignoreGlobs = Array.isArray(opts.ignoreGlobs) ? opts.ignoreGlobs : [];
  const extraGlobs = Array.isArray(opts.extraTriggerGlobs) ? opts.extraTriggerGlobs : [];
  const removalThreshold = opts.thresholds?.removal ?? 20;
  const volumeThreshold = opts.thresholds?.volume ?? 120;

  // 去掉无效路径（undefined / 空串）与纯生成物——这一步不改变「未知即保守」的语义，
  // 因为无路径的条目根本没法参与判定，如实跳过。
  const usable = [];
  for (const f of files) {
    const p = typeof f?.path === 'string' ? f.path.trim() : '';
    if (!p) continue;
    if (LOCKFILE_BASENAMES.has(basename(p))) continue;
    if (ARTIFACT_RE.test(p)) continue;
    if (ignoreGlobs.length > 0 && matchesAny(p, ignoreGlobs)) continue;
    usable.push({ ...f, path: p });
  }
  if (usable.length === 0) return err;

  const reasons = new Set();

  for (const f of usable) {
    if (isConfigFile(f.path)) reasons.add(REASONS.CONFIG);
    if (extraGlobs.length > 0 && matchesAny(f.path, extraGlobs)) reasons.add(REASONS.CONFIG);
    if (SECURITY_RE.test(f.path)) reasons.add(REASONS.SECURITY);
    if (f.status === 'D') reasons.add(REASONS.DELETION);
    // 新增 / 删除代码文件 = 动了模块边界
    if ((f.status === 'A' || f.status === 'D') && CODE_EXT_RE.test(f.path)) {
      reasons.add(REASONS.STRUCTURAL);
    }

    for (const line of f.added ?? []) {
      if (DECISION_RE.test(String(line))) reasons.add(REASONS.DECISION);
      if (PUBLIC_API_RE.test(String(line))) reasons.add(REASONS.PUBLIC_API);
    }
    for (const line of f.removed ?? []) {
      if (PUBLIC_API_RE.test(String(line))) reasons.add(REASONS.PUBLIC_API);
    }
  }

  // 跨模块：非文档文件分布在 ≥2 个不同的首段目录
  const tops = new Set();
  for (const f of usable) {
    if (DOC_RE.test(f.path)) continue;
    const segs = dirSegs(f.path);
    if (segs.length > 0) tops.add(segs[0]);
  }
  if (tops.size >= 2) reasons.add(REASONS.CROSS_MODULE);

  const totalAdded = snapshot.totals?.added
    ?? usable.reduce((n, f) => n + (f.added?.length ?? 0), 0);
  const totalRemoved = snapshot.totals?.removed
    ?? usable.reduce((n, f) => n + (f.removed?.length ?? 0), 0);

  if (totalRemoved >= removalThreshold) reasons.add(REASONS.DELETION);
  if (totalAdded + totalRemoved >= volumeThreshold) reasons.add(REASONS.VOLUME);

  // 纯注释 / 空白改动：能压掉「decision」「volume」这两类误报（正则可能被注释里的
  // 代码片段命中），但压不掉 config / security / public-api / deletion —— 那些是结构性的。
  if (isCommentOnly(usable)) {
    reasons.delete(REASONS.DECISION);
    reasons.delete(REASONS.VOLUME);
  }

  // 兜底：上面七条一条都没命中，但确实改了非注释的代码。
  //
  // 为什么需要它：七条规则回答的是「哪里最危险」，不是「哪里改了」。
  // 只改一两行、不碰配置/边界/安全面的改动一条都不命中，门禁就此沉默——
  // 用户看到的表现是「改完代码不自动评审，只能手动开」。
  // 纯注释 / 纯文档改动仍然放行：那种改动让门禁介入只是噪音。
  if (opts.reviewAnyCodeChange !== false && reasons.size === 0 && !isCommentOnly(usable)) {
    const codeFiles = usable.filter((f) => !DOC_RE.test(f.path));
    if (codeFiles.length > 0) reasons.add(REASONS.CODE);
  }

  const list = [...reasons];
  return { trigger: list.length > 0, reasons: list, undetermined: false };
}
