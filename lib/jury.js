/**
 * 陪审团判决层（M5）：三评审 + majority。
 *
 * 纯函数——不读文件、不跑 git、不调外部命令。所有取票在外面做完（lib/jury-store.js），
 * 这里只回答「这组票意味着什么」。这样每一种「票型」都能用合成输入单测钉住，
 * 不必起真会话、不必等专家。
 *
 * 为什么要有这一层：单专家评审只能证明「有一个评审看过了」。一个评审漏掉的东西
 * （尤其是它**没有**声明为风险的边界）在单票里是看不见的；固定三席（事实/反方/缺口）
 * 加多数决，并且把「边界外的问题」单列成 topped，不让它被多数票盖过去。
 *
 * 「三个视角」在实现里的含义（不是修辞）：三票必须指认**三个不同**、**本回合**发生的事实
 * （basis 去重 + expert 调用的回合绑定，见 basisSupportsVerdict / findDuplicateBasisRef
 * 与 lib/jury-basis.js），且 pass 只能由 expert 证据支撑。只证明「有一个真实事实存在」
 * 是不够的——同一个 callId 被三个角色各引用一次，多数决得到的 3 票其实只有 1 个证据。
 *
 * 判决集（刻意只有 5 个，且默认全部不放行）：
 *   pass        有票达到多数门槛且是 pass（唯一放行态）
 *   fail        多数票 fail
 *   topped      ≥2 票 insufficient 且其中 ≥2 票 boundary='external'：问题超出可评审边界，
 *               这类结论不适用多数决——换多少评审都判不了，必须交给能处理边界的人
 *   unclear     有效票全为 undecidable，或没有任何判决达到多数门槛（含票型分散）
 *   unavailable 无有效票 / 票非法 / 通道不可用（读不到、没落盘）
 *
 * 「不放行」是默认值：除 pass 之外的一切都返回 reviewed:false（接线见 lib/verdict.js）。
 */

/** 固定三席：事实派 / 反方派 / 缺口派。 */
import path from 'node:path';

export const JURY_ROLES = Object.freeze(['fact', 'opposition', 'gap']);

/** 单票的四种结论。insufficient = 证据不足以判（不是 fail）。 */
export const JURY_VERDICTS = Object.freeze(['pass', 'fail', 'insufficient', 'undecidable']);

/**
 * 边界：问题是否落在「本仓库/本改动可评审」的范围内。
 * external 的 insufficient 才是 topped 的构成要素——内部缺口应该继续补证据，
 * 外部缺口继续补证据是白费，必须显式交回。
 */
export const JURY_BOUNDARIES = Object.freeze(['internal', 'external']);

/**
 * 票的**证据类别**：每一票必须指认一个可核验的事实，否则它只是模型的一句自述。
 *
 *  · expert  指认本会话一次成功的「代码审查工程师」调用（callId）
 *  · canary  指认本会话一份 verified 的变异检定回执（ref='verified' 或某个被杀的变异体 id）
 *  · file    指认本会话实际写过的文件（绝对路径或相对仓库根的路径）
 *
 * 校验实现见 lib/jury-basis.js：纯函数 + 事件流/观察记录/回执三处事实来源。
 */
export const JURY_BASIS_KINDS = Object.freeze(['expert', 'canary', 'file']);

/** 席位数量（固定三席）。aggregateVotes 本身对任意 n 成立，这个常量只用于接线判定。 */
export const JURY_SEATS = 3;

const ROLE_SET = new Set(JURY_ROLES);
const VERDICT_SET = new Set(JURY_VERDICTS);
const BOUNDARY_SET = new Set(JURY_BOUNDARIES);
const BASIS_KIND_SET = new Set(JURY_BASIS_KINDS);

/** 判决集（聚合结果，不是单票结论）。 */
export const AGGREGATE_VERDICTS = Object.freeze(['pass', 'fail', 'topped', 'unclear', 'unavailable']);
const AGGREGATE_SET = new Set(AGGREGATE_VERDICTS);

/** 聚合判决是否属于「可以放行」。只有 pass 是。 */
export function isPassingJuryVerdict(value) {
  return value === 'pass';
}

/** 单票结论是否合法（供 verdict.js / 工具层共用，避免两处各写一份集合）。 */
export function isJuryVerdict(value) {
  return typeof value === 'string' && VERDICT_SET.has(value);
}

/** 聚合判决是否合法。 */
export function isAggregateVerdict(value) {
  return typeof value === 'string' && AGGREGATE_SET.has(value);
}

/**
 * 多数门槛：n 票里需要几票。
 *
 * 公式是 `Math.floor(n / 2) + 1`，所以 3 席取 2、5 席取 3、1 席取 1。
 * n 非正整数（含 0）时按 0 席处理 → 返回 1：没有可投的席位时门槛不构成放行依据，
 * 由 aggregateVotes 走 unavailable 分支，不靠这个数兜底。
 *
 * @param {number} n
 * @returns {number}
 */
export function needFor(n) {
  const size = typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  return Math.floor(size / 2) + 1;
}

function describe(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return value === '' ? '空字符串' : `"${value}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return '数组';
  return typeof value;
}

/**
 * 校验并归一化 `basis` 的**结构**（kind 合法、ref 非空）。
 *
 * 注意这一层只判形状：ref 能不能在事实里指认到，需要会话事件流/观察记录，
 * 由 lib/jury-basis.js 的 verifyVoteBasis 负责（纯判决层不读任何外部状态）。
 *
 * @param {unknown} basis
 * @returns {{ ok: true, basis: { kind: string, ref: string } } | { ok: false, reason: string }}
 */
export function normalizeBasis(basis) {
  if (basis === null || typeof basis !== 'object' || Array.isArray(basis)) {
    return { ok: false, reason: `basis 必须是对象，收到 ${describe(basis)}` };
  }
  const { kind, ref } = basis;
  if (typeof kind !== 'string' || !BASIS_KIND_SET.has(kind)) {
    return { ok: false, reason: `未知 basis.kind（${describe(kind)}），只接受 ${JURY_BASIS_KINDS.join(' / ')}` };
  }
  if (typeof ref !== 'string' || ref.trim() === '') {
    return { ok: false, reason: `basis.ref 必须是非空字符串，收到 ${describe(ref)}` };
  }
  return { ok: true, basis: { kind, ref: ref.trim() } };
}

/**
 * 一张票的 basis 能不能支撑它的 verdict。
 *
 * P0-1（评审实测的三条零成本路径）：`file` / `canary` 类证据只能证明「我看过 / 我跑过」，
 * 证明不了「我同意放行」。如果 pass 票也收这两种，那么「三票同指一个刚写过的文件」
 * 就是零成本通过——那与「连点三次工具」没有区别。所以：
 *   · pass        → 只接受 kind='expert'（一次真实的评审调用）
 *   · 其他 verdict → 三类都收（fail/insufficient 本来就需要它们来说明问题在哪）
 *
 * @param {unknown} basis
 * @param {unknown} verdict
 * @returns {{ ok: true, basis?: {kind:string, ref:string} } | { ok: false, reason: string }}
 */
export function basisSupportsVerdict(basis, verdict) {
  if (verdict !== 'pass') return { ok: true };
  const normalized = normalizeBasis(basis);
  if (!normalized.ok) return normalized;
  if (normalized.basis.kind === 'expert') return { ok: true, basis: normalized.basis };
  return {
    ok: false,
    reason: `pass 票只接受 basis.kind='expert'（收到 '${normalized.basis.kind}'）：`
      + 'file / canary 只能证明「我看过 / 我跑过」，证明不了「我同意放行」',
  };
}

/**
 * basis 的规范键（判重用）。file 类先做路径归一（`\`→`/`、去 `./`、压重复斜杠、去尾斜杠），
 * 其余类别按 kind + 去空白的 ref 精确比较。
 */
export function canonicalBasisRef(basis) {
  if (!basis || typeof basis !== 'object') return '';
  const kind = typeof basis.kind === 'string' ? basis.kind : '';
  if (kind === '') return '';
  let ref = typeof basis.ref === 'string' ? basis.ref.trim().replace(/\\/g, '/') : '';
  if (kind === 'file') {
    ref = ref.replace(/\/{2,}/g, '/');
    // `lib/../lib/x.js` 与 `lib/x.js` 是同一个事实：归一化要处理 `.` / `..`，
    // 否则换个写法就能绕过「三票必须指认三个不同事实」。
    try {
      ref = path.posix.normalize(ref);
    } catch {
      // 归一化失败就用原串（去重仍按精确比较，只是不折叠 `..`）
    }
    if (ref === '.') ref = '';
    while (ref.startsWith('./')) ref = ref.slice(2);
    while (ref.length > 1 && ref.endsWith('/')) ref = ref.slice(0, -1);
  }
  return ref === '' ? '' : `${kind}:${ref}`;
}

function fileRefsOverlap(a, b) {
  if (a === b) return true;
  // `lib/a.js` 与 `/repo/lib/a.js` 是同一个事实；裸 basename 不在这里放宽。
  return (a.includes('/') && b.endsWith(`/${a}`)) || (b.includes('/') && a.endsWith(`/${b}`));
}

/**
 * 三票必须指认**三个不同的事实**（P0-1 第 2 条）。
 *
 * 不去重的话，同一个 callId / 同一个文件可以被三个角色各引用一次，
 * 多数决得到的「3 票」其实只有 1 个证据。
 *
 * @returns {string|null} 重复说明（null = 没有重复）
 */
export function findDuplicateBasisRef(votes) {
  if (!Array.isArray(votes)) return null;
  const seen = [];
  for (let i = 0; i < votes.length; i += 1) {
    const vote = votes[i];
    if (!vote || typeof vote !== 'object' || !vote.basis) continue;
    const key = canonicalBasisRef(vote.basis);
    if (key === '') continue;
    const kind = vote.basis.kind;
    for (const prev of seen) {
      if (prev.kind !== kind) continue;
      const same = kind === 'file'
        ? fileRefsOverlap(prev.ref, key.slice('file:'.length))
        : prev.key === key;
      if (same) {
        return `第 ${i + 1} 票与第 ${prev.index + 1} 票指认同一个事实（${key}）`;
      }
    }
    seen.push({ index: i, key, kind, ref: key.slice(`${kind}:`.length) });
  }
  return null;
}

/**
 * 校验并归一化一票。
 *
 * 严格校验 role / verdict / boundary：这三个字段决定判决，任何未知值都只能落到
 * 「我不知道这是什么」——静默忽略一张坏票等于让它消失，而消失的票会被多数公式
 * 当成「没投」，最终可能把 2 票 pass 算成门槛达成。所以坏票必须让整组判决 unavailable。
 *
 * @param {unknown} raw
 * @returns {{ ok: true, vote: { role: string, verdict: string, boundary?: string, reason?: string } }
 *          | { ok: false, reason: string }}
 */
export function normalizeVote(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: `票必须是对象，收到 ${describe(raw)}` };
  }
  const { role, verdict, boundary, reason, basis, digest } = raw;
  if (typeof role !== 'string' || !ROLE_SET.has(role)) {
    return { ok: false, reason: `未知 role（${describe(role)}），只接受 ${JURY_ROLES.join(' / ')}` };
  }
  if (typeof verdict !== 'string' || !VERDICT_SET.has(verdict)) {
    return { ok: false, reason: `未知 verdict（${describe(verdict)}），只接受 ${JURY_VERDICTS.join(' / ')}` };
  }
  // boundary 是可选的；给了就必须合法。null 与 undefined 同样视为「没给」。
  let normalizedBoundary;
  if (boundary !== undefined && boundary !== null) {
    if (typeof boundary !== 'string' || !BOUNDARY_SET.has(boundary)) {
      return { ok: false, reason: `未知 boundary（${describe(boundary)}），只接受 ${JURY_BOUNDARIES.join(' / ')}` };
    }
    normalizedBoundary = boundary;
  }
  // basis 出现就必须合法；**是否必填由入箱口（jury_vote）判断**——纯聚合层允许
  // 无 basis 的票存在（单测用合成票验多数决），但不能接受一个「形状坏掉」的 basis。
  let normalizedBasis;
  if (basis !== undefined && basis !== null) {
    const checked = normalizeBasis(basis);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    normalizedBasis = checked.basis;
  }
  // digest 同理：给了就必须是非空字符串（票与哪一版 diff 绑定）。
  let normalizedDigest;
  if (digest !== undefined && digest !== null) {
    if (typeof digest !== 'string' || digest.trim() === '') {
      return { ok: false, reason: `digest 必须是非空字符串，收到 ${describe(digest)}` };
    }
    normalizedDigest = digest.trim();
  }
  const vote = { role, verdict };
  if (normalizedBoundary !== undefined) vote.boundary = normalizedBoundary;
  // reason 只做展示，不参与判决；非字符串一律丢掉（不因为一句说明把整组票作废）。
  if (typeof reason === 'string' && reason.trim() !== '') vote.reason = reason;
  if (normalizedBasis !== undefined) vote.basis = normalizedBasis;
  if (normalizedDigest !== undefined) vote.digest = normalizedDigest;
  return { ok: true, vote };
}

function emptyCounts() {
  return { pass: 0, fail: 0, insufficient: 0, undecidable: 0, total: 0 };
}

/**
 * 聚合一组票。
 *
 * 判定顺序与理由（顺序本身是契约，改顺序会改变边界票型的结论）：
 *  1. 坏输入先毙：非数组 / 任何一票不合法 → unavailable（绝不让坏票被多数公式「补掉」）
 *  2. 0 票 → unavailable（没取到票 ≠ 大家都没意见）
 *  3. 全 undecidable → unclear（都判不了，不是 fail 也不是 pass）
 *  4. pass 达到多数门槛 → pass（唯一放行态）
 *  5. fail 达到多数门槛 → fail
 *  6. topped：≥2 票 insufficient 且其中 ≥2 票 boundary='external'
 *     —— 放在 pass/fail 之后：多数已经明确时，边界票不该推翻多数；
 *        但多数形不成时，边界缺口是比「再补证据」更硬的结论。
 *  7. 其余 → unclear（票型分散 / 只有 insufficient 且不构成 topped）
 *
 * @param {unknown} votes
 * @returns {{ verdict: 'pass'|'fail'|'topped'|'unclear'|'unavailable', need: number, counts: {pass:number,fail:number,insufficient:number,undecidable:number,total:number}, reason: string }}
 */
export function aggregateVotes(votes) {
  const counts = emptyCounts();
  if (!Array.isArray(votes)) {
    return {
      verdict: 'unavailable',
      need: needFor(0),
      counts,
      reason: `票型必须是数组，收到 ${describe(votes)}`,
    };
  }

  const valid = [];
  for (let i = 0; i < votes.length; i += 1) {
    const normalized = normalizeVote(votes[i]);
    if (!normalized.ok) {
      return {
        verdict: 'unavailable',
        need: needFor(0),
        counts,
        reason: `第 ${i + 1} 票非法：${normalized.reason}`,
      };
    }
    valid.push(normalized.vote);
  }

  const n = valid.length;
  const need = needFor(n);
  counts.total = n;
  for (const vote of valid) counts[vote.verdict] += 1;

  if (n === 0) {
    return { verdict: 'unavailable', need, counts, reason: '没有有效票（通道不可用或还没人投票）' };
  }
  if (counts.undecidable === n) {
    return { verdict: 'unclear', need, counts, reason: `${n}/${n} 票 undecidable：全部判不了，不是通过` };
  }
  if (counts.pass >= need) {
    return { verdict: 'pass', need, counts, reason: `${counts.pass}/${n} 票 pass，达到门槛 ${need}/${n}` };
  }
  if (counts.fail >= need) {
    return { verdict: 'fail', need, counts, reason: `${counts.fail}/${n} 票 fail，达到门槛 ${need}/${n}` };
  }
  const externalInsufficient = valid.filter(
    (vote) => vote.verdict === 'insufficient' && vote.boundary === 'external',
  ).length;
  if (counts.insufficient >= 2 && externalInsufficient >= 2) {
    return {
      verdict: 'topped',
      need,
      counts,
      reason: `${externalInsufficient} 票 insufficient 且 boundary=external：问题超出可评审边界，多数决不适用，一律不放行`,
    };
  }
  return {
    verdict: 'unclear',
    need,
    counts,
    reason: `没有判决达到门槛 ${need}/${n}（pass=${counts.pass} fail=${counts.fail}`
      + ` insufficient=${counts.insufficient} undecidable=${counts.undecidable}）`,
  };
}

/**
 * 门禁层的票型成立条件：**三席齐备**才承认一个 pass，且**票必须绑在当前这版 diff 上**。
 *
 * 为什么单独一层而不是塞进 aggregateVotes：aggregateVotes 的契约是「对任意 n 做多数决」
 * （单测要覆盖 n=1/2/3/5），而门禁要的语义更强——三席里只到两票的 pass 可能是
 * 「第三票还没投完」的中间态。把「票没投完」当通过，正是这套门禁要防的谎报。
 *
 * digest 过滤是 P0 的第二半：票与 diff 版本绑定。传了 `digest` 时，**只要有一票的
 * digest 与当前不一致（含没有 digest 的旧票），整份票型判 unavailable**——
 * 不能把上一版 diff 拿到的 pass 用在改了之后的这一版上。
 *
 * 缺票时的结论是 unavailable（不是 unclear）：它表示「票型还不成立」，
 * 提示语要能引导去补票，而不是让人以为评审已经看完只是意见分散。
 * 非法票型沿用 aggregateVotes 的 unavailable（reason 原样带出）。
 *
 * @param {unknown} votes
 * @param {{ seats?: number, digest?: string }} [options]
 * @returns {ReturnType<typeof aggregateVotes>}
 */
export function aggregateJuryForGate(votes, options = {}) {
  const seats = Number.isInteger(options.seats) && options.seats > 0 ? options.seats : JURY_SEATS;
  const aggregated = aggregateVotes(votes);
  const wantDigest = typeof options.digest === 'string' && options.digest.trim() !== ''
    ? options.digest.trim()
    : undefined;
  // 先过 diff 绑定：与当前版本不一致的票，一律视为票型未成立（fail-safe）。
  if (wantDigest !== undefined && Array.isArray(votes)) {
    const stale = votes.filter((vote) => !vote || typeof vote !== 'object' || vote.digest !== wantDigest).length;
    if (stale > 0) {
      return {
        ...aggregated,
        verdict: 'unavailable',
        reason: `${stale}/${votes.length} 票与当前 diff 摘要不一致（票绑在别的版本上），票型不成立`,
      };
    }
  }
  if (Array.isArray(votes)) {
    // P0-1 第 1 条：pass 只能由 expert 支撑。这里再做一遍（入箱口也拦）——
    // 票箱是本地 JSON，手改过的 journal 必须同样被挡住。
    for (let i = 0; i < votes.length; i += 1) {
      const one = votes[i];
      if (!one || typeof one !== 'object') continue; // 结构坏票已由 aggregateVotes 判 unavailable
      const support = basisSupportsVerdict(one.basis, one.verdict);
      if (!support.ok) {
        return {
          ...aggregated,
          verdict: 'unavailable',
          reason: `第 ${i + 1} 票（${one.role ?? '?'}）不能用该 basis 支撑 ${String(one.verdict)}：${support.reason}`,
        };
      }
    }
    // P0-1 第 2 条：三票必须指认三个不同的事实，否则「3 票」其实只有 1 个证据。
    const duplicate = findDuplicateBasisRef(votes);
    if (duplicate !== null) {
      return {
        ...aggregated,
        verdict: 'unavailable',
        reason: `${duplicate}：三票指认同一个事实，不构成三个视角`,
      };
    }
  }
  if (aggregated.verdict !== 'pass') return aggregated;
  const cast = Array.isArray(votes) ? votes.length : 0;
  if (cast < seats) {
    return {
      ...aggregated,
      verdict: 'unavailable',
      reason: `需要 ${seats} 席齐备才算票型（当前 ${cast} 票），pass 不能当已通过`,
    };
  }
  return aggregated;
}
