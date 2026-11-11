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
import fs from 'node:fs';
import path from 'node:path';
import { runCanary, recordReceipt, CANARY_STATUS } from './canary.js';
import { applyConfig, getConfig } from './config.js';
import { diag, pluginVersion } from './diag.js';
import { collectDiff } from './evidence.js';
import { handleTurnStopping, statusOf, STEER_SOURCE_KIND } from './gate.js';
import { REVIEW_TOOL, SUBAGENT_REFUSAL, decideToolUse } from './review-tool-policy.js';
import { classifyTrigger } from './trigger.js';
import { bumpQuietStep, observedPaths, quietStepOf, recordWrite, repoRootFromObserved, resolveSessionId, QUIET_STEPS_BEFORE_GATE } from './observed.js';

/**
 * 写进系统提示的「优先取证」约定。
 * 目标：让 agent 在收尾前主动取证，而不是被门禁拦下后再补一轮（白费一次）。
 */
const REVIEW_FIRST_PROMPT = [
  '## 代码改动的取证约定（dsh-review-gate）',
  '',
  '本机装了评审门禁：改动命中高风险特征时会被记录下来，但门禁**不会再把回合推回**。',
  '',
  '评审有两条路，发起人都是你（主会话）：',
  '',
  '1. **直接调 `dsh_code_review` 工具**（推荐，2026-11-11 起恢复）：同步返回完整报告，拿到就能立刻按发现改；',
  '   失败/中断就直接如实汇报，**不要在同一轮里自动重试**。',
  '2. 运行 **`/review` 命令**：后台异步投递报告，不冻结输入框；需要指定别的工作树时用 `/review --cwd <绝对路径>`。',
  '',
  '门禁还会在回合收尾时替你自动跑一次 `/review` 兜底，但**不要指望它**——收尾前自己取证。',
  '',
  '| 改动特征 | 收尾前必须做 |',
  '|---|---|',
  '| 改/增删 `package.json`、`*.config.*`、`cordis.patch.yml`、`Dockerfile`、`.github/` 或 `k8s/` 下的 yml/json | 一次评审 |',
  '| **新增或删除代码文件**（等于动了模块边界） | 评审 + `lens` 的 `impact` / `circular` / `metrics` |',
  '| 路径含 `auth` / `secret` / `token` / `crypto` / `credential` / `permission` / `guard` | 一次评审 |',
  '| 新增行含判定表达式（`.every` / `.some` / `.filter` / `.includes` / `new Set(` / `if (` / 三元） | 一次评审 |',
  '',
  '**纯运维回合不触发评审**（只做 `git add/commit/push/tag`、read/lens 等，没有写文件）：这类回合门禁直接放行。',
  '',
  '审的时候不要只跑工具，要逐条回答：边界输入（空值/undefined/单值/合法+非法）会怎样、这次改动的验收载体是什么、那个证据能不能红一次。',
  '',
  '取证失败（例如拿不到 diff）时，如实写「未评审」，不要装作已经审过。',
  '',
  '所以：命中下表特征时，主会话收尾前**自己调用 `dsh_code_review`** 拿一份独立评审，',
  '不要只提醒用户「可运行 /review」——那等于把该你做的取证推给用户。',
  '**子 Agent（专家、审查子、teammate）一律不要调用**：它们拿不到这个工具（宿主侧 deny），',
  '调用只会浪费一轮；把改动与结论交回主会话统一评审。',
].join('\n');

export const name = 'review-gate';

/**
 * 必须声明依赖 tools：否则 apply() 执行时 ctx.tools 可能还没就位，
 * 于是「注册状态工具」那段被 if 守卫静默跳过 —— 工具永远不出现，
 * 而插件状态仍是 active。实测：v0.4.0 及之前 review_gate_status 在所有会话里都不存在。
 */
export const inject = ['tools', 'commands', 'workingDirectory'];

export { STEER_SOURCE_KIND };

/**
 * 不 inject tools：门禁本身只依赖 turn-stopping seam。
 * status 工具存在时顺带注册，缺失也不影响门禁工作。
 */

export function apply(ctx, config) {
  const cfg = applyConfig(config);
  const disposers = [];

  const label = cfg.gate ? 'review gate armed' : 'review gate disabled by config';

  /**
   * 硬约束：`dsh_code_review` 只允许在主会话调用（用户 2026-11-10 要求）。
   *
   * 为什么必须硬拦而不是写提示词：这个工具会 spawn 独立审查子 Agent，而审查子继承
   * 全局 AGENTS.md 的「开工先叫人」，于是可能反过来召唤 Agency 专家；专家又被要求
   * 「交付前跑一次评审」→ 再起审查子 → 成环（实测跑到 delegationDepth=4）。
   * 把工具限制在主会话，环的闭合边就不存在。
   *
   * 用 ctx.tools.guard()：同步返回理由即拒，且在 tools/pre-execute 之后执行，
   * 后挂的监听器翻不了案——比提示词与 pre-execute 都硬。
   */
  let offGuard;
  const hasGuard = typeof ctx.tools?.guard === 'function';
  if (hasGuard) {
    disposers.push(ctx.effect(() => ctx.tools.guard((exec) => {
      const verdict = decideToolUse({
        name: exec?.name,
        origin: exec?.agent?.session?.header?.origin,
        // 与 gate.js 的 isSubagent 同源：header 优先，再取 session 上的值。
        depth: exec?.agent?.session?.header?.delegationDepth ?? exec?.agent?.session?.delegationDepth,
      });
      if (verdict.deny !== true) return undefined;
      diag(`guard: 拒绝子 Agent 调用 ${REVIEW_TOOL} agent=${exec?.agent?.id ?? '?'}`);
      // 自愈：把工具从该 agent 的工具面摘掉，模型下一步不会再撞墙。
      try {
        // 自愈：摘掉**本次实际命中的那个名字**。用常量 REVIEW_TOOL 会在命中
        // 命名空间变体（mcp__x__dsh_code_review）时摘错——那条仍留着，下一步再撞墙。
        exec.agent?.ctx?.tools?.restrict?.({ deny: [typeof exec?.name === 'string' && exec.name !== '' ? exec.name : REVIEW_TOOL] });
      } catch { /* 自愈失败不影响本次拒绝 */ }
      return verdict.reason ?? SUBAGENT_REFUSAL;
    })));
  } else {
    // 兜底：宿主没有 guard() 时退化到 tools/pre-execute 瀑布（可被后挂监听器翻案，
    // 但总比让硬约束静默消失强）。两条路径共用同一个纯判定 decideToolUse()。
    diag('guard: 宿主无 ctx.tools.guard()，降级到 tools/pre-execute');
    try {
      offGuard = ctx.on('tools/pre-execute', async (exec, next) => {
        const verdict = decideToolUse({
          name: exec?.name,
          origin: exec?.agent?.session?.header?.origin,
          depth: exec?.agent?.session?.header?.delegationDepth ?? exec?.agent?.session?.delegationDepth,
        });
        if (verdict.deny !== true) return next();
        diag(`pre-execute: 拒绝子 Agent 调用 ${REVIEW_TOOL} agent=${exec?.agent?.id ?? '?'}`);
        return { kind: 'deny', reason: verdict.reason ?? SUBAGENT_REFUSAL };
      });
    } catch (error) {
      diag(`guard: 兜底也挂不上：${String(error)}`);
    }
  }

  // ---- 回合结束门禁 ----------------------------------------------------
  let offTurn;
  try {
    offTurn = ctx.on('agent/turn-stopping', (...args) => {
      const payload = args[0];
      if (!payload || typeof payload !== 'object' || !payload.agent) return undefined;
      // 必须返回 promise：turn-stopping 是被 await 的串行检查点，
      // fire-and-forget 会和回合关闭赛跑，steer 直接丢失。
      // 实时目录：header.cwd 是会话创建时的身份字段，cd 之后不会更新
      // （宿主只用它做恢复冲突）。worktree / working_directory 改的是 workingDirectory 服务，
      // 所以这里必须把它传进去，否则门禁会拿创建时目录去取证。
      //
      // ⚠️ 这里必须**提取出字符串**：`workingDirectory.get()` 在某些宿主上直接返回目录
      // 记录对象而不是字符串。早期直接把它当 cwd 传下去，`resolveSessionCwd` 的类型守卫
      // 会把它丢掉 → 实时目录从未生效、日志里出现「会话根 [object Object]」。
      // 未知形状一律返回 undefined（宁可退回 header，也不要拿对象当路径）。
      const liveCwd = (agent) => {
        try {
          const got = ctx.workingDirectory?.get?.(agent?.session);
          if (typeof got === 'string') return got;
          if (got && typeof got === 'object') {
            for (const key of ['cwd', 'path', 'directory', 'dir']) {
              const value = got[key];
              if (typeof value === 'string' && value.trim() !== '') return value;
            }
          }
          return undefined;
        } catch {
          return undefined;
        }
      };
      // 2026-11-11：不再注入 runCommand。门禁已删除「代跑 /review」那条路径，
      // 评审发起方只有模型自己（dsh_code_review 工具）或用户亲手敲 /review。
      const deps = { liveCwd };
      return handleTurnStopping(payload, deps).then((text) => {
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
  // ---- 系统提示注入：让 agent 一开始就知道要优先取证 ----
  // 只靠事后 steer 是补救，代价是一轮返工。把约定提前写进系统提示，
  // agent 在动手/收尾时就能主动取证，不必等被拦。
  // 用 ctx.inject 做可选依赖：拿不到 systemPrompt 也不影响门禁本身。
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['systemPrompt'], (spCtx) => {
        try {
          const sp = spCtx.systemPrompt;
          if (!sp || typeof sp.section !== 'function') return;
          const dispose = sp.section({
            name: 'review-gate:review-first',
            // 紧跟其他工具指引之前，确保被读到
            order: 72,
            text: () => cfg.gate ? REVIEW_FIRST_PROMPT : '',
            interpolate: false,
          });
          if (typeof dispose === 'function') disposers.push(dispose);
          diag('system prompt section armed (review-first)');
        } catch (error) {
          diag(`system prompt section failed: ${String(error)}`);
        }
      });
    }
  } catch (error) {
    diag(`system prompt inject failed: ${String(error)}`);
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
        // 给 agent 一个「主动取证」的窗口：刚写完文件的下一步不拦。
        // 实测教训：直接拦会在 agent 正要调 dsh_code_review 的那一刻抢先介入，
        // 反而制造了这套机制本想避免的那次返工。
        const quiet = bumpQuietStep(sid);
        if (quiet < QUIET_STEPS_BEFORE_GATE) {
          diag(`pre-step: quiet=${quiet} < ${QUIET_STEPS_BEFORE_GATE}，让路（可能正在取证）`);
          return result;
        }
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
    `apply v${pluginVersion()} gate=${cfg.gate}`
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
            // 策略开关必须可观测：否则「改完代码到底会不会自动评审」只能靠猜日志。
            policies: {
              reviewAnyCodeChange: c.reviewAnyCodeChange,
              canaryShadow: c.canaryShadow,
            },
            ...state,
          };
        },
      });
      disposers.push(ctx.effect(() => ctx.tools.register(statusTool)));


      /**
       * 变异检定工具（canary）。
       *
       * 它回答的是本插件反复验证过的那个真问题：「你说测试过了——那条断言会红吗？」
       * 做法是把被测代码按 mutants.json 改坏，看有没有一条**具名**断言变红。
       *
       * 证明力边界必须写在描述里，否则调用方会以为它证明了更多：
       * 它只证明「存在一条会红的断言」，**不证明**那条断言判对了逻辑。
       */
      const canaryTool = defineTool({
        name: 'canary_verify',
        description: '跑变异检定：按 mutants.json 把被测代码改坏，确认有没有一条具名断言会变红（只能证明「存在会红的断言」，不证明断言判对了逻辑）。本会话拿到回执后门禁会记录 canary 状态（当前为 shadow，不参与放行）。',
        parameters: {
          mutantsPath: { type: 'string', description: '可选：变异体清单路径，默认取仓库根的 mutants.json' },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
          const sessionCwd = exec?.agent?.session?.header?.cwd || process.cwd();
          const sid = resolveSessionId(exec) ?? resolveSessionId(exec?.agent);

          // 找清单：显式路径优先；否则 cwd，再否则「本会话写过的文件」反推的仓库根。
          let specPath = typeof args?.mutantsPath === 'string' && args.mutantsPath
            ? path.resolve(sessionCwd, args.mutantsPath)
            : path.join(sessionCwd, 'mutants.json');
          let root = sessionCwd;
          if (!fs.existsSync(specPath)) {
            const guess = await repoRootFromObserved(sid);
            if (guess && fs.existsSync(path.join(guess, 'mutants.json'))) {
              root = guess;
              specPath = path.join(guess, 'mutants.json');
            }
          }
          if (!fs.existsSync(specPath)) {
            // 没有清单就是没有可检定的对象，不能返回一句「没发现问题」当通过。
            throw new Error(
              `canary_verify 找不到变异体清单：${specPath}。`
              + '请在仓库根写一份 mutants.json（{ baselineCmd, mutants: [{ id, file, old, new, expectRed }] }），'
              + '或在结论里明确写「未做变异检定」。',
            );
          }

          let spec;
          try {
            spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
          } catch (e) {
            throw new Error(`canary_verify 读不懂变异体清单 ${specPath}：${e.message}`);
          }

          const receipt = runCanary({ cwd: root, baselineCmd: spec.baselineCmd, mutants: spec.mutants });
          // 不论结论如何都记下来：unproven 也是一种需要被看到的事实。
          recordReceipt(sid, receipt);

          if (receipt.status !== CANARY_STATUS.OK) {
            // 无法判定不等于通过：必须显式失败，否则调用方会把「没跑成」当「没问题」。
            throw new Error(
              `canary_verify 无法给出判定（${receipt.status}）：${receipt.reason || '见 mutants'}。`
              + '请在结论里明确写「未取得变异检定回执」，不要当作已证明。',
            );
          }
          return {
            status: receipt.status,
            killed: receipt.killed,
            baseline: receipt.baseline,
            mutants: receipt.mutants,
            note: receipt.killed
              ? '至少一条变异体被具名断言杀死：证明「存在会红的断言」，不证明断言判对了逻辑。'
              : '没有变异体被具名断言杀死：说明现有断言覆盖不到这些改动，不是「脚本跑成功了」。',
          };
        },
      });
      disposers.push(ctx.effect(() => ctx.tools.register(canaryTool)));
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
