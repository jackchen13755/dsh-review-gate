/**
 * 配置：默认值 + 运行时覆盖（环境变量优先于 patch 配置）。
 * 单例，只在 apply() 时写一次——门禁路径上每回合都要读，不能反复解析。
 */

const DEFAULTS = Object.freeze({
  gate: true,
  gateMaxSteersPerTurn: 1,
  gateMaxSteersPerSession: 3,
  removalThreshold: 20,
  volumeThreshold: 120,
  gateSubagents: true,
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
    gateMaxSteersPerTurn: coerceInt(cfg.gateMaxSteersPerTurn, DEFAULTS.gateMaxSteersPerTurn, 0),
    gateMaxSteersPerSession: coerceInt(cfg.gateMaxSteersPerSession, DEFAULTS.gateMaxSteersPerSession, 0),
    removalThreshold: coerceInt(cfg.removalThreshold, DEFAULTS.removalThreshold, 0),
    volumeThreshold: coerceInt(cfg.volumeThreshold, DEFAULTS.volumeThreshold, 0),
    gateSubagents: coerceBool(cfg.gateSubagents, DEFAULTS.gateSubagents),
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
