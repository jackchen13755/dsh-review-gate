/**
 * 变异检定引擎（canary）：证明「存在一条会红的断言」，而不是「测试全绿」。
 *
 * 为什么需要它：本插件反复验证过一件事——「测试全绿」是假信号。
 * 一条断言只要没覆盖到被改的那一格，代码写错它照样绿。要证明断言有效，
 * 唯一的机械办法是**把被测代码改坏，看它会不会红**。
 *
 * 设计上最贵的不是跑变异，而是**不把假红当成杀死**。实测踩过的坑：
 *   1. 用 `exit code !== 0` 当杀死 —— 改名导出会让整份文件加载失败，红的
 *      是「文件级条目」，一条断言都没红（必须逐条测试名差分，并剔除文件级条目）。
 *   2. 红了一条 ≠ 红的是你要那条 —— 只认 expectRed 命中的断言，否则降级
 *      KILLED_BY_OTHER_ASSERTION（它也是有效杀死，但证的不是这条断言）。
 *   3. 等价变异体 SURVIVED 是**正确结论**（改注释不该让测试红），
 *      把它记成失败会逼人写垃圾断言。
 *   4. 默认 spec 报告器解析不出用例 → 基线 pass=0 → 一切都被判 SURVIVED；
 *      必须强制 TAP，且基线必须解析到 >0 条。
 *   5. `cp -al` 硬链接会让「写副本」把原件一起改掉（副本与原件共享 inode）。
 *   6. **变异体那一跑完全没有 TAP 输出时，不能当成「没有断言红」**——
 *      命令压根没跑（二进制不存在 / 超时）也会是空输出，此时判 SURVIVED
 *      就是把「没跑」洗成「跑通了」。实测踩过：`cmd: "no-such-binary"` 返回
 *      `status:"ok"` + `SURVIVED`。
 *   7. `String.replace(pattern, string)` 会做 `$&`/`$'`/`$$` 展开，且后像是
 *      undefined 时会写进字面量 `undefined`。变异体字符串里出现这些符号，
 *      真变异会被静默改成空操作 → 又变成假 SURVIVED。必须用函数形式替换。
 *
 * 所以：任一前置条件不满足，一律返回 undetermined / SPEC_INVALID，绝不猜。
 * 「无法判定」是诚实结论；猜出来的「通过」才是污染。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** 变异体判定结果。只有 KILLED_* 算「这条变异体被断言抓到了」。 */
export const MUTANT_VERDICT = Object.freeze({
  KILLED_BY_ASSERTION: 'KILLED_BY_ASSERTION',
  KILLED_BY_OTHER_ASSERTION: 'KILLED_BY_OTHER_ASSERTION',
  SURVIVED: 'SURVIVED',
  SPEC_INVALID: 'SPEC_INVALID',
});

/** 整体结论。undetermined 必须与「跑过了且通过」区分开。 */
export const CANARY_STATUS = Object.freeze({
  OK: 'ok',
  UNDETERMINED: 'undetermined',
  SPEC_INVALID: 'spec-invalid',
});

/** 会话级回执状态：有没有一份「能红一次」的回执。 */
export const CANARY_STATE = Object.freeze({
  VERIFIED: 'verified',
  UNPROVEN: 'unproven',
  MISSING: 'missing',
});

/** TAP 里的「文件级条目」：node --test 在文件加载失败时会报这种名字。 */
const FILE_LEVEL_RE = /\.(test|spec)\.(m?js|cjs|ts|tsx|jsx)$/;

/**
 * 本会话的回执（shadow 阶段只用来写状态，不参与放行）。
 *
 * 注意这一版是**会话级**的：回执没有与 diff 摘要绑定，所以「上回合拿到过一份
 * 能红一次的回执」无法证明「覆盖了这版改动」。绑定 diff 摘要是下一版的事，
 * 在那之前这个状态只能用于观察，不能用于放行。
 */
const sessionReceipts = new Map();

export function recordReceipt(sid, receipt) {
  if (typeof sid !== 'string' || sid === '') return;
  if (!receipt || typeof receipt !== 'object') return;
  sessionReceipts.set(sid, receipt);
  // 长跑进程下只增不减 = 慢性泄漏
  if (sessionReceipts.size > 200) {
    const first = sessionReceipts.keys().next().value;
    if (first !== undefined) sessionReceipts.delete(first);
  }
}

export function canaryStateOf(sid) {
  const r = sessionReceipts.get(sid);
  if (!r) return CANARY_STATE.MISSING;
  return r.killed === true ? CANARY_STATE.VERIFIED : CANARY_STATE.UNPROVEN;
}

export function clearCanaryState() {
  sessionReceipts.clear();
}

/**
 * 解析 TAP 输出。
 *
 * 只认 `ok N - <name>` / `not ok N - <name>` 两种行；带 `# SKIP` / `# TODO`
 * 的条目不算（它们本来就没跑）。
 */
export function parseTap(output) {
  const pass = [];
  const fail = [];
  for (const raw of String(output).split('\n')) {
    const line = raw.trim();
    const m = /^(not ok|ok)\s+\d+\s+-\s+(.*)$/.exec(line);
    if (!m) continue;
    let name = m[2];
    if (/#\s*(SKIP|TODO)\b/i.test(name)) continue;
    name = name.replace(/\s+#.*$/, '').trim();
    if (name === '') continue;
    if (m[1] === 'not ok') fail.push(name);
    else pass.push(name);
  }
  return { pass, fail };
}

/**
 * 单个变异体的判决。
 *
 * @param {{ baseline: {pass: string[], fail: string[]}, mutantFail: string[], expectRed?: string }} args
 */
export function decideMutant({ baseline, mutantFail, expectRed }) {
  if (typeof expectRed !== 'string' || expectRed.trim() === '') {
    // 没声明 expectRed 就无法判断「红的是不是你要那条」，不能猜。
    return { verdict: MUTANT_VERDICT.SPEC_INVALID, reason: '变异体没有声明 expectRed' };
  }
  const basePass = new Set(baseline.pass);
  const baseFail = new Set(baseline.fail);

  // 只算「基线里是绿的、这时变红了」的断言；基线本来就红的与本次无关。
  const newlyRed = mutantFail.filter((n) => basePass.has(n) && !baseFail.has(n));
  // 文件级条目（加载失败）不是断言，一条都不能算数。
  const assertionRed = newlyRed.filter((n) => !FILE_LEVEL_RE.test(n));

  const named = assertionRed.filter((n) => n.includes(expectRed));
  if (named.length > 0) {
    return { verdict: MUTANT_VERDICT.KILLED_BY_ASSERTION, redAssertions: named };
  }
  if (assertionRed.length > 0) {
    // 确实杀死了，但不是声明的那条断言：不能算数，也不能说没效果。
    return { verdict: MUTANT_VERDICT.KILLED_BY_OTHER_ASSERTION, redAssertions: assertionRed };
  }
  return { verdict: MUTANT_VERDICT.SURVIVED };
}

/** 变异体条目的形状校验：一个坏条目不许让整轮检定崩掉。 */
export function validateMutant(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return '变异体条目不是对象';
  if (typeof m.file !== 'string' || m.file === '') return 'file（目标文件）缺失或不是字符串';
  if (typeof m.old !== 'string' || m.old === '') return 'old（前像）缺失或不是字符串';
  if (typeof m.new !== 'string') return 'new（后像）缺失或不是字符串';
  if (typeof m.expectRed !== 'string' || m.expectRed.trim() === '') return 'expectRed 缺失';
  if (m.cmd !== undefined && typeof m.cmd !== 'string') return 'cmd 不是字符串';
  return null;
}

/**
 * 把前像替换成后像，**只做字面替换**。
 *
 * 为什么不能直接 `source.replace(oldText, newText)`：
 *   1. 第二个参数是字符串时，`$&` / `` $` `` / `$'` / `$$` 会被当成替换模式展开。
 *      变异体后像里出现这些符号（模板串、正则、shell 片段都很常见）时，
 *      真变异会被静默改成别的东西——甚至被改成空操作，于是判成 SURVIVED。
 *   2. `newText` 是 undefined 时会被写成字面量 `undefined`，语法错误后按文件级
 *      条目被剔除，同样退化成 SURVIVED。
 * 用函数式替换可以同时关掉这两条。
 */
export function substituteOnce(source, oldText, newText) {
  if (typeof newText !== 'string') {
    throw new TypeError('后像（new）必须是字符串');
  }
  return source.replace(oldText, () => newText);
}

function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const at = haystack.indexOf(needle, i);
    if (at === -1) return n;
    n += 1;
    i = at + needle.length;
  }
}

function runCmd(cmd, cwd, timeoutMs) {
  const parts = String(cmd).trim().split(/\s+/);
  const bin = parts[0];
  const args = parts.slice(1);
  // 关键：父级若是 `node --test`，它会给子进程注入 NODE_TEST_CONTEXT，
  // 子进程于是走「上报给父运行器」的通道、不再输出 TAP，被解析成「基线 0 条」。
  // 实测过：外层单独跑正常、在测试里跑就是 undetermined。必须显式剔除。
  // NODE_OPTIONS 同理——父进程的 --test-* 选项不该渗透进被检定的仓库。
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  try {
    const out = execFileSync(bin, args, {
      cwd,
      env,
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, output: out };
  } catch (e) {
    // 测试失败时 node --test 退出码非 0，但 TAP 仍然有效，不能丢掉输出。
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}`, error: e };
  }
}

/** 复制一份工作副本。故意不用 cp -al：硬链接会让写副本改到原件。 */
function copyTree(src, dst) {
  fs.cpSync(src, dst, {
    recursive: true,
    dereference: false,
    filter: (p) => {
      const base = path.basename(p);
      return base !== 'node_modules' && base !== '.git';
    },
  });
}

/** 跑一遍命令并要求它能解析出「全绿且 >0 条」的基线。 */
function readBaseline(cmd, cwd, timeoutMs) {
  const run = runCmd(cmd, cwd, timeoutMs);
  const parsed = parseTap(run.output);
  const total = parsed.pass.length + parsed.fail.length;
  if (total === 0) {
    // 解析不到 = 报告器不对或命令压根没跑起来。此时任何判决都是假的。
    return { ok: false, reason: `解析到 0 条用例（报告器可能不是 TAP，或命令没跑起来）：${cmd}` };
  }
  if (parsed.fail.length > 0) {
    return { ok: false, reason: `基线本身就有 ${parsed.fail.length} 条失败，无法区分「变异导致」与「本来就红」` };
  }
  return { ok: true, parsed };
}

/**
 * 跑一轮变异检定。
 *
 * @param {{
 *   cwd: string,
 *   mutants: Array<{ id: string, file: string, old: string, new: string, expectRed: string, cmd?: string }>,
 *   baselineCmd?: string,
 *   timeoutMs?: number,
 *   keepWorkdir?: boolean,
 * }} opts
 * @returns {{ status: string, killed: boolean, reason?: string, baseline?: object, mutants?: object[], workdir?: string }}
 */
export function runCanary(opts = {}) {
  const { cwd, mutants } = opts;
  const baselineCmd = opts.baselineCmd ?? 'node --test --test-reporter=tap tests/';
  const timeoutMs = opts.timeoutMs ?? 120000;

  if (typeof cwd !== 'string' || !fs.existsSync(cwd)) {
    return { status: CANARY_STATUS.UNDETERMINED, killed: false, reason: 'cwd 不存在，无法建立隔离副本' };
  }
  if (!Array.isArray(mutants) || mutants.length === 0) {
    return { status: CANARY_STATUS.UNDETERMINED, killed: false, reason: '没有声明任何变异体（空清单不算通过）' };
  }

  let workdir;
  try {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-'));
    copyTree(cwd, path.join(workdir, 'repo'));
  } catch (e) {
    if (workdir) fs.rmSync(workdir, { recursive: true, force: true });
    return { status: CANARY_STATUS.UNDETERMINED, killed: false, reason: `隔离副本建立失败：${e.message}` };
  }
  const repo = path.join(workdir, 'repo');

  try {
    // 前置①：基线必须能跑、且能解析到 >0 条用例、且全绿。
    const base = readBaseline(baselineCmd, repo, timeoutMs);
    if (!base.ok) {
      return { status: CANARY_STATUS.UNDETERMINED, killed: false, reason: base.reason };
    }

    /** 每个 cmd 各自的基线（变异体可以换命令，换命令就必须换基线）。 */
    const baselineCache = new Map([[baselineCmd, base.parsed]]);
    const baselineFor = (cmd) => {
      if (baselineCache.has(cmd)) return { ok: true, parsed: baselineCache.get(cmd) };
      const got = readBaseline(cmd, repo, timeoutMs);
      if (got.ok) baselineCache.set(cmd, got.parsed);
      return got;
    };

    const results = [];
    for (const m of mutants) {
      const bad = validateMutant(m);
      if (bad) {
        results.push({ id: (m && m.id) || '(no id)', verdict: MUTANT_VERDICT.SPEC_INVALID, reason: bad });
        continue;
      }
      const cmd = m.cmd ?? baselineCmd;
      // 自带命令的变异体必须用自己的基线比对，否则红断言全被 basePass 过滤掉。
      const own = baselineFor(cmd);
      if (!own.ok) {
        results.push({ id: m.id, verdict: MUTANT_VERDICT.SPEC_INVALID, reason: `该变异体的命令自身基线不可用：${own.reason}` });
        continue;
      }

      const target = path.join(repo, m.file);
      let pristine;
      try {
        pristine = fs.readFileSync(target, 'utf8');
      } catch {
        results.push({ id: m.id, verdict: MUTANT_VERDICT.SPEC_INVALID, reason: `目标文件读不到：${m.file}` });
        continue;
      }
      const hits = countOccurrences(pristine, m.old);
      if (hits !== 1) {
        // 0 次 = 前像对不上（代码已变）；≥2 次 = 不知道改哪一处。都不许猜。
        results.push({
          id: m.id,
          verdict: MUTANT_VERDICT.SPEC_INVALID,
          reason: `前像在 ${m.file} 出现 ${hits} 次（必须恰好 1 次）`,
        });
        continue;
      }

      // 用函数形式替换：关掉 $& / $' / $$ 展开，也不会把 undefined 写进源码。
      try {
        fs.writeFileSync(target, substituteOnce(pristine, m.old, m.new));
        const run = runCmd(cmd, repo, timeoutMs);
        const mutantParsed = parseTap(run.output);
        if (mutantParsed.pass.length + mutantParsed.fail.length === 0) {
          // 命令没跑起来 / 没有 TAP：不许洗成「没有断言红」。
          results.push({
            id: m.id,
            verdict: MUTANT_VERDICT.SPEC_INVALID,
            reason: `变异体那一跑没有 TAP 输出（命令没跑起来或报告器不对）：${cmd}`,
          });
          continue;
        }
        results.push({
          id: m.id,
          cmd,
          ...decideMutant({ baseline: own.parsed, mutantFail: mutantParsed.fail, expectRed: m.expectRed }),
        });
      } finally {
        // 无论中间抛什么，都要把副本还原干净，别影响下一个变异体。
        try {
          fs.writeFileSync(target, pristine);
        } catch {
          // 副本已被写坏到无法还原：标记出来，不要静默继续。
          results.push({ id: m.id, verdict: MUTANT_VERDICT.SPEC_INVALID, reason: '还原目标文件失败' });
        }
      }
    }

    const anySpecInvalid = results.some((r) => r.verdict === MUTANT_VERDICT.SPEC_INVALID);
    return {
      status: anySpecInvalid ? CANARY_STATUS.SPEC_INVALID : CANARY_STATUS.OK,
      // 只有「至少一条变异体被**具名断言**杀死」才算拿到了证明。
      // 全部 SURVIVED 是有效结论（断言没覆盖），但它是「没证明」，不是「通过」。
      killed: results.some((r) => r.verdict === MUTANT_VERDICT.KILLED_BY_ASSERTION),
      baseline: { pass: base.parsed.pass.length, fail: base.parsed.fail.length, cmd: baselineCmd },
      mutants: results,
      workdir: opts.keepWorkdir ? workdir : undefined,
    };
  } finally {
    // 副本一律回收：不回收会在 /tmp 里堆整仓拷贝（实测积过 42 份）。
    if (!opts.keepWorkdir && workdir) {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  }
}
