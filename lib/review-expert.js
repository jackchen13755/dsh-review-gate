/**
 * 评审证据的唯一判据：**主会话有没有把改动交给「代码审查工程师」专家**。
 *
 * 2026-11-16 契约变更：第三方 `@michengai/dsh-code-review` 已从 desktop profile 卸载，
 * `dsh_code_review` 工具与 `/review` 命令都不存在了。旧判据（「本回合调过那个工具」）
 * 于是永远为假 —— 门禁会一直判「没评审」并持续催，模型照着提示也永远满足不了。
 * 现在唯一合法的评审入口是专家：
 *
 *   summon_expert("代码审查工程师", 任务书)            ← 单个
 *   summon_experts({ experts: [{ expert: "…" }, …] })  ← 批量（含该专家也算）
 *
 * 这是一段**判定代码**，所以三条纪律写死在这里：
 *  1. 只认「工具名命中」**且**「expert 参数命中」——只认其中一个会把
 *     `summon_expert("UI 设计师")` 当成评审，等于门禁整体失效；
 *  2. 专家名用**精确别名**匹配，不做子串包含：`代码审查工程师助理` 不是评审工程师，
 *     `engineering-code-reviewer-x` 也不是。子串匹配会把「名字里带这几个字」的
 *     任何工具/专家都算成评审证据（旧的工具名守卫就是靠 `__` 分隔规避这个坑的）；
 *  3. 输入形状不可信（arguments 可能是字符串、对象、undefined、坏 JSON），
 *     任何一种都只能得出「不是评审证据」，**绝不抛错**——门禁自己坏掉不该改变放行行为，
 *     但也不该把一个坏输入当成证据。
 *
 * 纯函数，便于喂边界输入单测（tests/review-expert.test.js）。
 */

/** 中文显示名：任务书与提示文案里出现的就是这一个。 */
export const REVIEW_EXPERT_DISPLAY_NAME = '代码审查工程师';

/**
 * 被接受的专家标识（精确匹配，大小写/空白归一后比较）。
 * 与 `list_experts` / `expert_brief` 接受的三种写法一致：全名 / 简名 / division 写法。
 */
export const REVIEW_EXPERT_ALIASES = Object.freeze([
  '代码审查工程师',
  'engineering-code-reviewer',
  'code-reviewer',
  'engineering/code-reviewer',
]);

/** 有能力召唤专家的工具（命名空间变体另算，见 isReviewToolName）。 */
export const REVIEW_TOOL_NAMES = Object.freeze(['summon_expert', 'summon_experts']);

/** 提示文案里给出的可复制示例（唯一入口，不再有第二条路）。 */
export const REVIEW_CALL_EXAMPLE = 'summon_expert("代码审查工程师", 任务书)';

/**
 * 工具名归一化匹配：整名相等，或 `__` 分隔后的末段相等。
 *
 * 刻意**不用**字符串包含：`summon_expert_v2` / `summon_experts_backup` 这类以本名开头的
 * 其它工具必须继续被忽略（有单测钉住）。同时保留 `mcp__x__summon_expert` 这种
 * 命名空间前缀——宿主/网关包装工具时会这么改名，靠 includes 判断会误伤系列似名字。
 */
export function isReviewToolName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed === '') return false;
  return REVIEW_TOOL_NAMES.some((tool) => trimmed === tool || trimmed.endsWith(`__${tool}`));
}

/** 专家名归一化：去首尾空白、折叠内部空白、小写。非字符串一律空串。 */
export function normalizeExpertName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

const ALIAS_SET = new Set(REVIEW_EXPERT_ALIASES.map((alias) => normalizeExpertName(alias)));

/** 这个 expert 参数是不是「代码审查工程师」。非字符串/空值一律 false。 */
export function isReviewExpert(value) {
  const normalized = normalizeExpertName(value);
  return normalized !== '' && ALIAS_SET.has(normalized);
}

/**
 * 把一次调用里的 arguments 读成对象。字符串按 JSON 解析，对象原样返回，
 * 其余（undefined / null / 数字 / 坏 JSON）返回 undefined。
 */
function argumentObjectOf(raw) {
  if (raw !== null && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 取一次召唤调用里点名的所有专家。
 *
 * 两种工具的参数形状都收：
 *   summon_expert  → { expert: '…', task: '…' }
 *   summon_experts → { experts: [{ expert: '…', task: '…' }, …] }
 * 数组元素是裸字符串也认（宿主/适配层可能只给名字）。无法识别的形状一律返回空数组。
 *
 * @returns {string[]} 点名的专家名（保持原顺序，可能为空）
 */
export function expertNamesOfCall(call) {
  const args = argumentObjectOf(call?.arguments);
  if (args === undefined) return [];
  const out = [];
  if (typeof args.expert === 'string') out.push(args.expert);
  if (Array.isArray(args.experts)) {
    for (const item of args.experts) {
      if (typeof item === 'string') out.push(item);
      else if (item !== null && typeof item === 'object' && typeof item.expert === 'string') out.push(item.expert);
    }
  }
  return out;
}

/**
 * 这次调用算不算「把改动交给代码审查工程师评审」。
 *
 * 批量召唤的取舍：`summon_experts` 里**只要有一位**是代码审查工程师就算。
 * 理由：批量就是并发跑多位专家，评审那位真的跑了、报告真的产出了；
 * 要求「必须单独再叫一次」只会惩罚合理的批量，逼出一次无意义的重复调用。
 * （反方向——批量里只有 UI 设计师 → 不算，有单测钉住。）
 */
export function isReviewExpertCall(call) {
  if (call === null || typeof call !== 'object') return false;
  if (!isReviewToolName(call.name)) return false;
  return expertNamesOfCall(call).some((name) => isReviewExpert(name));
}
