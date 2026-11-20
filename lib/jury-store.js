/**
 * 陪审团票箱：把「谁投了什么、绑在哪条证据与哪版 diff 上」落盘，供门禁下一回合读。
 *
 * 位置：`$DSH_HOME/review-gate/jury/<sha256(sessionId)>.json`
 *
 * 为什么不写 `$DSH_HOME/code-review/`（lib/journal.js:5-6 那个目录）：
 * 那是第三方 code-review 插件的 journal，本插件的硬约束是「**不修改任何第三方插件**的产物」，
 * 只读它做交叉校验。陪审团票是本插件自己的状态，必须有自己的目录——
 * 写进别人的 journal 既会污染它的判定，也会让「只读层」这条边界悄悄消失。
 *
 * 形状（version 1）：{ version, sessionId, updatedAt, votes: [{ role, verdict, boundary?, reason?, basis:{kind,ref}, digest }] }
 *
 * 两条 fail-safe 口径：
 *  1. 读不到 / JSON 坏 / 任何一票非法 → `invalid: true`，**绝不静默丢坏票**。
 *     静默丢弃会把「3 张好票 + 1 张坏票」读成 3 张好票，从而把本应 unavailable 的票型
 *     算成 pass——与 aggregateVotes「一张坏票就 unavailable」的口径正好相反。
 *  2. 入箱必须带 `digest` 与 `basis`：没有它们，一张票无法区分「针对这版代码的真实评审」
 *     与「模型连点三次按钮」。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dshHome } from './journal.js';
import { JURY_ROLES, basisSupportsVerdict, findDuplicateBasisRef, normalizeVote } from './jury.js';

/** 票箱目录（与第三方 review journal 分开）。 */
export function juryDir() {
  return path.join(dshHome(), 'review-gate', 'jury');
}

export function juryJournalPathFor(sessionId) {
  const hash = createHash('sha256').update(String(sessionId)).digest('hex');
  return path.join(juryDir(), `${hash}.json`);
}

/** 同一角色重复投票 = 改票（三席固定，不该出现第四票）。上限只防坏数据把文件撑大。 */
const MAX_VOTES = JURY_ROLES.length * 4;

/** 会话 -> 票箱读取结果 { votes, invalid, reason }。进程内缓存，避免门禁每回合都读盘。 */
const cache = new Map();
const MAX_SESSIONS = 500;

function capCache() {
  while (cache.size > MAX_SESSIONS) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function validSessionKey(sessionId) {
  return typeof sessionId === 'string' && sessionId.trim() !== '';
}

function remember(sessionId, entry) {
  cache.set(sessionId, entry);
  capCache();
  return entry;
}

function emptyJournal(reason = '') {
  return { votes: [], invalid: false, reason };
}

/**
 * 读某会话票箱。
 *
 * @returns {{ votes: object[], invalid: boolean, reason: string, path: string }}
 *   invalid=true 表示**票型不可用**（坏 JSON / 形状不认识 / 有一张非法票）。
 *   门禁拿到 invalid 必须判 unavailable，不能拿剩下的票去算多数。
 */
export function readJuryJournal(sessionId) {
  const file = validSessionKey(sessionId) ? juryJournalPathFor(sessionId) : '';
  if (file === '') return { ...emptyJournal('缺少会话 id'), path: '' };
  if (cache.has(sessionId)) {
    const cached = cache.get(sessionId);
    return { ...cached, votes: cached.votes.slice(), path: file };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    // 文件不存在 ≠ 坏文件：前者是「还没投票」，后者是「票箱坏了」，必须能区分。
    if (error && error.code === 'ENOENT') {
      const entry = remember(sessionId, emptyJournal());
      return { ...entry, votes: [], path: file };
    }
    const entry = remember(sessionId, { votes: [], invalid: true, reason: '票箱不是合法 JSON，票型不可用' });
    return { ...entry, path: file };
  }

  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.votes)) {
    const entry = remember(sessionId, { votes: [], invalid: true, reason: '票箱形状不认识（votes 不是数组），票型不可用' });
    return { ...entry, path: file };
  }

  const votes = [];
  for (let i = 0; i < raw.votes.length; i += 1) {
    const normalized = normalizeVote(raw.votes[i]);
    if (!normalized.ok) {
      // 一张坏票 = 整份票箱不可用。不静默丢弃它，否则多数决会把坏票「补掉」。
      const entry = remember(sessionId, {
        votes: [],
        invalid: true,
        reason: `票箱第 ${i + 1} 票非法（${normalized.reason}），整份票型不可用`,
      });
      return { ...entry, path: file };
    }
    votes.push(normalized.vote);
  }
  const entry = remember(sessionId, { votes: votes.slice(0, MAX_VOTES), invalid: false, reason: '' });
  return { ...entry, votes: entry.votes.slice(), path: file };
}

/**
 * 登记一票（同角色覆盖）。
 *
 * @param {string} sessionId
 * @param {unknown} rawVote 必须含 role / verdict / basis（可选 boundary / reason）
 * @param {{ digest?: string }} [options] digest 由门禁给出的「当前这版 diff 摘要」，权威值
 * @returns {{ ok: true, votes: object[] } | { ok: false, reason: string }}
 */
export function castJuryVote(sessionId, rawVote, options = {}) {
  if (!validSessionKey(sessionId)) return { ok: false, reason: '缺少会话 id，票无法归档' };

  const digest = typeof options.digest === 'string' ? options.digest.trim() : '';
  if (digest === '') {
    return {
      ok: false,
      reason: '缺少 digest：票必须绑在当前这版 diff 上，而门禁还没有可用的 diff 摘要（先让门禁看到本次改动）',
    };
  }

  const normalized = normalizeVote(rawVote);
  if (!normalized.ok) return { ok: false, reason: normalized.reason };
  if (!normalized.vote.basis) {
    return {
      ok: false,
      reason: '缺少 basis：每一票必须指认一个可核验的证据（{ kind: expert|canary|file, ref }），无证据的票不收',
    };
  }

  // P0-1 第 1 条：pass 只能由 expert 支撑。file / canary 只能证明「我看过 / 我跑过」，
  // 证明不了「我同意放行」——否则「三个角色同指一个刚写过的文件」就是零成本通过。
  const support = basisSupportsVerdict(normalized.vote.basis, normalized.vote.verdict);
  if (!support.ok) return { ok: false, reason: support.reason };

  const current = readJuryJournal(sessionId);
  if (current.invalid === true) {
    return { ok: false, reason: `票箱当前不可用（${current.reason}）；先 jury_vote(action:'reset') 清空再投` };
  }

  // digest 以门禁的值为准：调用方自己塞的 digest 不作数（否则票可以自称绑在任意版本上）。
  const vote = { ...normalized.vote, digest };
  const next = current.votes.filter((existing) => existing.role !== vote.role);
  // P0-1 第 2 条：三个角色不能指认同一个事实（同一个 callId / 同一个文件）。
  // 同角色改票不算冲突（它替换的是自己那一票）。
  const duplicate = findDuplicateBasisRef([...next, vote]);
  if (duplicate !== null) {
    return {
      ok: false,
      reason: `${duplicate}：三票必须指认三个不同的事实（同一个 callId / 文件不能给两个角色用）`,
    };
  }
  next.push(vote);
  const capped = next.slice(-MAX_VOTES);
  remember(sessionId, { votes: capped.slice(), invalid: false, reason: '' });
  persist(sessionId, capped);
  return { ok: true, votes: capped.slice() };
}

/** 清空某会话票型（票已被一次判决消费 / 人工重置）。 */
export function clearJuryVotes(sessionId) {
  if (!validSessionKey(sessionId)) return;
  cache.delete(sessionId);
  try {
    fs.rmSync(juryJournalPathFor(sessionId), { force: true });
  } catch {
    // 删不掉不影响内存状态；下一轮 read 会重建缓存
  }
}

/** 测试用：清空进程内缓存（不动磁盘，避免测试互相污染真实目录）。 */
export function resetJuryStoreForTests() {
  cache.clear();
}

function persist(sessionId, votes) {
  try {
    fs.mkdirSync(juryDir(), { recursive: true });
    const body = JSON.stringify(
      { version: 1, sessionId, updatedAt: new Date().toISOString(), votes },
      null,
      2,
    );
    fs.writeFileSync(juryJournalPathFor(sessionId), `${body}\n`, 'utf8');
  } catch {
    // 落盘失败只影响「插件重载后是否还在」，不能让投票本身失败。
  }
}
