/**
 * 配置：默认值 + 运行时覆盖（环境变量优先于 patch 配置）。
 * 单例，只在 apply() 时写一次——门禁路径上每回合都要读，不能反复解析。
 */

const DEFAULTS = Object.freeze({
  gate: true,
  /**
   * 是否用 agent.steer() 把回合推回去要求评审。
   *
   * 默认值保持 true 以兼容既有测试与旧宿主；**发布配置（cordis.patch.yml）显式设为 false**：
   * @michengai/dsh-code-review 1.0.9+ 不再注册 dsh_code_review 工具，评审改成 /review
   * 命令（用户触发、模型无法自己调用）。继续推回只会把模型推进一个永远满足不了的要求，
   * 所以实际运行是「只记录状态 + 在结论里提醒用户跑 /review」。
   */
  steer: true,
  /**
   * 自动评审（2026-11-10 起默认 true）。
   *
   * 1.0.9+ 的 code-review 插件只有 /review 命令，模型自己调不了。宿主提供
   * `ctx.commands.execute(agent, line, attachments, signal)`（「解析并执行已知命令，
   * 不经过模型」），门禁据此在判定「需要评审」时替模型执行 `/review`——效果等于用户
   * 亲手敲命令，但不需要人工介入。发起失败则退回「只记录 + 提示」。
   */
  autoReview: true,
  /**
   * 是否给 /review 传 `--cwd <写入根>`（自研 fork 支持）。
   *
   * 会话在 A、改动在 B（主仓库 + `.worktrees/<feat>`）时，光靠会话目录审不到 B；
   * 自研 fork 的 `/review --cwd <path>` 可以。用第三方版本（不支持该参数）时设 false，
   * 门禁会退化成「拒绝自动评审 + 提示去 B 目录开会话」。
   */
  autoReviewCwd: true,
  /** 自动评审时传给 /review 的输入。 */
  autoReviewInput: '审查未提交的更改',
  /** 发起命令的等待上限（毫秒）：/review 只负责提交请求，正常很快返回。 */
  autoReviewTimeoutMs: 8000,
  gateMaxSteersPerTurn: 1,
  /**
   * 每会话最多推回几次。
   *
   * 原来是 3。但「改了代码就评审」生效后，3 次意味着一个正常长度的会话在第 3 回合
   * 之后就被静默放行，用户看到的表现又变成「不自动评审了」——预算太紧会把
   * 兜底规则架空。20 足够覆盖一个长会话，仍保留上限防止死循环。
   */
  gateMaxSteersPerSession: 20,
  /**
   * 兜底规则：只要改动里有非注释的代码变更就要评审（纯注释/纯文档放行）。
   * 关掉它就退回「只在命中七条规则时评审」的旧行为。
   */
  reviewAnyCodeChange: true,
  removalThreshold: 20,
  volumeThreshold: 120,
  /**
   * canary（变异检定）shadow 开关。
   *
   * 打开时门禁只在状态里记录「本会话有没有拿到一份能红一次的回执」，
   * **不参与放行**——这是刻意的第一步：先观察误伤与伪造情况，再谈武器化。
   * 本仓库两次教训（v0.8.1 pre-step 误伤、v0.9.0 stale 死路）都是新判据直接
   * 上线造成的，同一个坑不踩第三次。
   */
  canaryShadow: true,
  ignoreGlobs: [],
  extraTriggerGlobs: [],
  /** turn-stopping 上的整体时间预算（毫秒）。超时一律 fail-open。 */
  timeoutMs: 5000,
  /** 关闭调试输出（DSH_REVIEW_GATE_DEBUG=1 打开）。 */
  debug: false,
});

let current = { ...DEFAULTS };

function coerceInt(value, fallback, min = 0) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.trunc(n));
}

function coerceBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return fallback;
}

function coerceGlobs(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((g) => typeof g === 'string' && g.trim() !== '').map((g) => g.trim());
}

/** 由 apply() 调用一次，把 patch 配置与环境变量合并进来。 */
export function applyConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  current = {
    gate: coerceBool(process.env.DSH_REVIEW_GATE, coerceBool(cfg.gate, DEFAULTS.gate)),
    steer: coerceBool(process.env.DSH_REVIEW_GATE_STEER, coerceBool(cfg.steer, DEFAULTS.steer)),
    autoReview: coerceBool(process.env.DSH_REVIEW_GATE_AUTO, coerceBool(cfg.autoReview, DEFAULTS.autoReview)),
    autoReviewCwd: coerceBool(cfg.autoReviewCwd, DEFAULTS.autoReviewCwd),
    autoReviewInput: typeof cfg.autoReviewInput === 'string' && cfg.autoReviewInput.trim() !== ''
      ? cfg.autoReviewInput.trim()
      : DEFAULTS.autoReviewInput,
    autoReviewTimeoutMs: coerceInt(cfg.autoReviewTimeoutMs, DEFAULTS.autoReviewTimeoutMs, 500),
    gateMaxSteersPerTurn: coerceInt(cfg.gateMaxSteersPerTurn, DEFAULTS.gateMaxSteersPerTurn, 0),
    gateMaxSteersPerSession: coerceInt(cfg.gateMaxSteersPerSession, DEFAULTS.gateMaxSteersPerSession, 0),
    reviewAnyCodeChange: coerceBool(cfg.reviewAnyCodeChange, DEFAULTS.reviewAnyCodeChange),
    removalThreshold: coerceInt(cfg.removalThreshold, DEFAULTS.removalThreshold, 0),
    volumeThreshold: coerceInt(cfg.volumeThreshold, DEFAULTS.volumeThreshold, 0),
    canaryShadow: coerceBool(cfg.canaryShadow, DEFAULTS.canaryShadow),
    ignoreGlobs: coerceGlobs(cfg.ignoreGlobs),
    extraTriggerGlobs: coerceGlobs(cfg.extraTriggerGlobs),
    timeoutMs: coerceInt(cfg.timeoutMs, DEFAULTS.timeoutMs, 200),
    debug: coerceBool(process.env.DSH_REVIEW_GATE_DEBUG, DEFAULTS.debug),
  };
  return current;
}

export function getConfig() {
  return current;
}

export function resetConfigForTests() {
  current = { ...DEFAULTS };
  return current;
}
