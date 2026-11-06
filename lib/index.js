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
import { renderBrief } from './brief.js';
import { applyConfig, getConfig } from './config.js';
import { diag, pluginVersion } from './diag.js';
import { collectDiff } from './evidence.js';
import { handleTurnStopping, statusOf, STEER_SOURCE_KIND } from './gate.js';
import { classifyTrigger } from './trigger.js';
import { observedPaths, recordWrite, repoRootFromObserved, resolveSessionId } from './observed.js';

export const name = 'review-gate';

/**
 * 必须声明依赖 tools：否则 apply() 执行时 ctx.tools 可能还没就位，
 * 于是「注册状态工具」那段被 if 守卫静默跳过 —— 工具永远不出现，
 * 而插件状态仍是 active。实测：v0.4.0 及之前 review_gate_status 在所有会话里都不存在。
 */
export const inject = ['tools'];

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
  // 预算为 0 是合法配置，但它等于把门禁关掉。必须明确说出来——
  // 「日志说 armed、实际一次都不拦」是本插件最反对的失效形态。
  const budgetOff = cfg.gateMaxSteersPerTurn <= 0 || cfg.gateMaxSteersPerSession <= 0;
  if (cfg.gate && budgetOff) {
    ctx.logger?.warn?.(
      '[dsh-review-gate] steer 预算为 0（perTurn=%s, perSession=%s）——门禁实际不会拦截任何回合',
      String(cfg.gateMaxSteersPerTurn),
      String(cfg.gateMaxSteersPerSession),
    );
  }
  // ---- pre-step 兜底：专门治「回合不结束 → turn-stopping 永不触发」----
  // 实测 session-32e3f08e：父会话 85 次工具调用、12 次 edit，但 turn/end=0
  // （被中断/超时/长时间不结束），于是门禁一次都没跑，改动全程零保护。
  // agent/pre-step 在每一步之前触发，只要会话还在干活就会走到，不依赖 turn/end。
  let offPreStep;
  try {
    offPreStep = ctx.on('agent/pre-step', async (payload, next) => {
      // 瀑布钩子：必须先拿到底层结果，再决定要不要介入
      const result = typeof next === 'function' ? await next() : undefined;
      try {
        if (!cfg.gate) return result;
        const agent = payload && payload.agent ? payload.agent : undefined;
        if (!agent || typeof agent.steer !== 'function') return result;
        // 只在「已经改过文件却没评审」时介入，避免每一步都打扰
        const sid = resolveSessionId(agent);
        if (!sid) return result;
        if (observedPaths(sid).length === 0) return result;
        // 复用同一套判定，但用独立预算桶，避免和 turn-stopping 互相吃额度
        const text = await handleTurnStopping(
          { agent, turn: payload?.turn },
          { budgetKey: 'pre-step' },
        );
        if (text) diag(`pre-step steered agent=${agent.id ?? '?'} turn=${payload?.turn ?? '?'}`);
      } catch {
        // 兜底钩子绝不能影响主流程
      }
      return result;
    });
  } catch (error) {
    ctx.logger?.warn?.('[dsh-review-gate] pre-step 兜底未挂上：%s', String(error));
  }
  if (typeof offPreStep === 'function') {
    disposers.push(offPreStep);
    diag('pre-step fallback armed');
  } else {
    diag('pre-step fallback UNAVAILABLE');
  }

  // 落盘一份，因为 ctx.logger 的输出在排查时往往看不到
  diag(
    `apply v${pluginVersion()} gate=${cfg.gate} subagents=${cfg.gateSubagents}`
    + ` perTurn=${cfg.gateMaxSteersPerTurn} perSession=${cfg.gateMaxSteersPerSession}`
    + ` seam=${typeof offTurn === 'function' ? 'armed' : 'UNAVAILABLE'}`
    + (cfg.gate && budgetOff ? ' EFFECTIVELY-OFF(budget=0)' : ''),
  );

  // 探测工具服务的真实形状：门禁需要知道「本会话到底有没有 dsh_code_review」，
  // 否则会给一个拿不到该工具的子会话（例如 agency 专家）下无法完成的指令。
  // 不猜 API —— 把 keys 与可调用成员落盘，从真实运行里读答案。
  try {
    const svc = ctx.tools;
    const keys = svc && typeof svc === 'object' ? Object.keys(svc) : [];
    const fns = keys.filter((k) => typeof svc[k] === 'function');
    diag(`tools-api keys=[${keys.slice(0, 40).join(',')}] fns=[${fns.join(',')}]`);
  } catch (error) {
    diag(`tools-api probe failed: ${String(error)}`);
  }

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

      /**
       * 评审取证工具。
       *
       * 为什么不复用 @michengai/dsh-code-review：它的 execute 需要 spawn 一个原生子 Agent
       * 来做审查，因此 inject 了 subagents/userQuestions 等服务；而 agency 专家子会话
       * 不提供这些服务 → 插件在专家上下文里不激活 → dsh_code_review 工具直接消失。
       * 本工具只依赖 tools，所以在任何上下文里都能加载；代价是审查由调用者自己完成。
       * 工具描述里必须写明这一点，不能让调用者以为得到了一份独立评审。
       */
      const briefTool = defineTool({
        name: 'review_brief',
        description: '收集未提交改动的完整取证（diff、文件清单、规模、按改动类型生成的审查清单）并返回，由调用者自己完成评审。不 spawn 子 Agent，因此在拿不到 dsh_code_review 的会话（如专家子会话）里同样可用。',
        parameters: {
          input: { type: 'string', description: '可选：补充的审查重点，会写进简报和清单' },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: String((value && value.brief) || value) }],
        },
        async execute(args, exec) {
          const sessionCwd = exec?.agent?.session?.header?.cwd || process.cwd();
          const sid = resolveSessionId(exec) ?? resolveSessionId(exec?.agent);
          // 会话 cwd 未必是 git 仓库（实测：cwd 是 plugins 父目录，改动在子仓库里）。
          // 先按 cwd 试；不行就按「本会话写过的文件路径」反推仓库根再试。
          let snap = await collectDiff(sessionCwd);
          let usedRoot = sessionCwd;
          if (snap.available !== true && sid) {
            const root = await repoRootFromObserved(sid);
            if (root && root !== sessionCwd) {
              const retry = await collectDiff(root);
              if (retry.available === true) {
                snap = retry;
                usedRoot = root;
              }
            }
          }
          // 拿不到改动就必须抛错，不能返回一句软话当"审过了"——
          // 门禁把「成功的工具调用」当评审证据，软返回会造成假阳性放行。
          if (snap.available !== true) {
            throw new Error(
              'review_brief 无法取得改动：' + (snap.reason || '未知原因')
              + '。已尝试会话 cwd 与本次写过的文件所在仓库，均取不到 diff。'
              + '请在结论里明确写「未能获取 diff，未评审」，不要当作已完成。',
            );
          }
          if (usedRoot !== sessionCwd) diag(`review_brief: cwd 无 diff，改用仓库根 ${usedRoot}`);
          const cls = classifyTrigger(snap, {
            ignoreGlobs: getConfig().ignoreGlobs,
            extraTriggerGlobs: getConfig().extraTriggerGlobs,
            thresholds: { removal: getConfig().removalThreshold, volume: getConfig().volumeThreshold },
          });
          return {
            files: Array.isArray(snap.files) ? snap.files.length : 0,
            available: snap.available === true,
            reasons: cls.reasons,
            brief: renderBrief(snap, { reasons: cls.reasons, note: args?.input }),
          };
        },
      });
      disposers.push(ctx.effect(() => ctx.tools.register(briefTool)));
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

        // 必须在 next() **之前**判断文件是否存在 —— 写完之后它必然存在，
        // 那时再判就永远判不出「本次新建」，structural 规则也就永远不触发。
        let existedBefore = true;
        let targetPath = '';
        try {
          const a = execution.arguments && typeof execution.arguments === 'object' ? execution.arguments : {};
          targetPath = typeof a.file_path === 'string'
            ? a.file_path
            : (typeof a.file === 'string' ? a.file : '');
          if (targetPath) {
            const { existsSync } = await import('node:fs');
            existedBefore = existsSync(targetPath);
          }
        } catch {
          existedBefore = true; // 判不了就当已存在，宁可不报新增（不误报）
        }

        const result = await next();
        try {
          const failed = !!result && typeof result === 'object' && result.isError === true;
          if (targetPath && !failed) {
            const sid = resolveSessionId(execution) ?? resolveSessionId(execution.agent);
            if (sid) recordWrite(sid, targetPath, { created: !existedBefore });
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
