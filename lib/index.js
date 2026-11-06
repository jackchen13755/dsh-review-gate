/**
 * dsh-review-gate — 回合结束强制评审门禁。
 *
 * 设计底线：**不修改任何第三方插件**。判定依据全部来自只读观测——
 *   · 会话日志里的 tool/call（宿主写的事实，主判据，不可伪造）
 *   · 第三方 code-review 插件落盘的 journal（交叉校验，防 finished-but-failed）
 *   · 自算的 git diff 摘要（新鲜度，防「评审完又偷改」）
 *
 * 挂载点：agent/turn-stopping（被 await 的串行检查点），通过 agent.steer() 把回合
 * 拉回一步，而不是静默结束。每回合 1 次 + 每会话 3 次双预算自限。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { applyConfig, getConfig } from './config.js';
import { diag, pluginVersion } from './diag.js';
import { handleTurnStopping, statusOf, STEER_SOURCE_KIND } from './gate.js';
import { recordWrite, resolveSessionId } from './observed.js';

export const name = 'review-gate';

export { STEER_SOURCE_KIND };

/**
 * 不 inject tools：门禁本身只依赖 turn-stopping seam。
 * status 工具存在时顺带注册，缺失也不影响门禁工作。
 */

export function apply(ctx, config) {
  const cfg = applyConfig(config);
  const disposers = [];

  const label = cfg.gate ? 'review gate armed' : 'review gate disabled by config';

  // ---- 回合结束门禁 ----------------------------------------------------
  let offTurn;
  try {
    offTurn = ctx.on('agent/turn-stopping', (...args) => {
      const payload = args[0];
      if (!payload || typeof payload !== 'object' || !payload.agent) return undefined;
      // 必须返回 promise：turn-stopping 是被 await 的串行检查点，
      // fire-and-forget 会和回合关闭赛跑，steer 直接丢失。
      return handleTurnStopping(payload).then((text) => {
        try {
          const st = statusOf(payload.agent?.id)?.last ?? {};
          diag(
            `turn-stopping agent=${payload.agent?.id ?? '?'} turn=${payload.turn ?? '?'}`
            + ` depth=${payload.agent?.session?.header?.delegationDepth ?? payload.agent?.session?.delegationDepth ?? 0}`
            + ` steered=${text ? 'YES' : 'no'}`
            + ` skipped=${st.skipped ?? '-'} reasons=${Array.isArray(st.reasons) ? st.reasons.join('|') : '-'}`,
          );
        } catch { /* 诊断不能影响门禁 */ }
        return undefined;
      });
    });
  } catch (error) {
    ctx.logger?.warn?.('[dsh-review-gate] 挂载 agent/turn-stopping 失败：%s', String(error));
  }

  if (typeof offTurn === 'function') {
    disposers.push(offTurn);
    ctx.logger?.info?.('[dsh-review-gate] %s (agent/turn-stopping)', label);
  } else {
    // 静默失效的门禁比没有门禁更糟——你会以为自己被保护着。
    ctx.logger?.warn?.(
      '[dsh-review-gate] agent/turn-stopping unavailable — completion gate disabled'
      + '（工具与判定逻辑仍在，但不会在回合结束时介入）',
    );
  }
  // 落盘一份，因为 ctx.logger 的输出在排查时往往看不到
  diag(
    `apply v${pluginVersion()} gate=${cfg.gate} subagents=${cfg.gateSubagents}`
    + ` seam=${typeof offTurn === 'function' ? 'armed' : 'UNAVAILABLE'}`,
  );

  // ---- 只读状态工具（便于验证与排障，不可用来放行）----------------------
  // 必须用 defineTool 包装，且 parameters 是「字段名 → 字段描述」的扁平映射，
  // 不是 JSON Schema 的 {type:'object',properties}。直接传裸对象不会注册成功。
  try {
    if (ctx.tools && typeof ctx.tools.register === 'function' && typeof ctx.effect === 'function') {
      const statusTool = defineTool({
        name: 'review_gate_status',
        description: '只读查看评审门禁的最近一次判定、跳过原因与预算余量。不改变任何状态，不能用来放行。',
        parameters: {
          agentId: { type: 'string', description: '会话 id；省略则返回全局状态' },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args) {
          const c = getConfig();
          const state = statusOf(args && args.agentId);
          return {
            gate: c.gate,
            limits: { perTurn: c.gateMaxSteersPerTurn, perSession: c.gateMaxSteersPerSession },
            thresholds: { removal: c.removalThreshold, volume: c.volumeThreshold },
            subagents: c.gateSubagents,
            ...state,
          };
        },
      });
      disposers.push(ctx.effect(() => ctx.tools.register(statusTool)));
    }
  } catch (error) {
    ctx.logger?.warn?.('[dsh-review-gate] review_gate_status 未注册：%s', String(error));
  }

  // ---- 观察写操作（供非 git 目录下做降级取证）--------------------------
  // 只用 tools/execute 包装：拿到 execution.name 与 execution.arguments，
  // 必须调用 next() 真正执行，并只在成功（非 isError）时记录。
  try {
    if (typeof ctx.on === 'function') {
      const onToolExecute = async (...args) => {
        const execution = args[0];
        const next = args[1];
        if (typeof next !== 'function') return undefined;
        if (!execution || (execution.name !== 'edit' && execution.name !== 'write')) return next();

        const result = await next();
        try {
          const a = execution.arguments && typeof execution.arguments === 'object' ? execution.arguments : {};
          const filePath = typeof a.file_path === 'string'
            ? a.file_path
            : (typeof a.file === 'string' ? a.file : '');
          const failed = !!result && typeof result === 'object' && result.isError === true;
          if (filePath && !failed) {
            const sid = resolveSessionId(execution) ?? resolveSessionId(execution.agent);
            if (sid) recordWrite(sid, filePath);
          }
        } catch {
          // 观察失败绝不影响工具本身
        }
        return result;
      };
      const offTool = ctx.on('tools/execute', onToolExecute);
      if (typeof offTool === 'function') disposers.push(offTool);
    }
  } catch (error) {
    ctx.logger?.warn?.('[dsh-review-gate] 写操作观察未挂上（降级取证不可用）：%s', String(error));
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const off of disposers) {
        try { off?.(); } catch { /* ignore */ }
      }
    });
  }
}
