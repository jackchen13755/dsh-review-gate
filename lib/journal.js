/**
 * 只读层：读第三方 @michengai/dsh-code-review 落盘的评审 journal。
 *
 * 本插件**不修改**它，只读它的产物。位置与文件名规则来自对它源码的实读
 * （lib/journal.js 用 sha256(agent.id) 命名，目录在 $DSH_HOME/code-review）：
 *   $DSH_HOME/code-review/<sha256(agent.id)>.json
 * 形状 { version: 1, state: 'running'|'finished', commandId?, result? }。
 *
 * 两个必须正面处理的坑（都已实测）：
 *  1. state === 'finished' **不等于成功**：失败分支在抛错之前就写了 finished，
 *     所以必须同时看 result.status。
 *  2. 这个文件是普通 JSON，模型有 write 工具就能伪造。因此它只能当**交叉校验**，
 *     不能当唯一判据——主判据是会话日志里的 tool/call（宿主写的，编不出来）。
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 视为「这次评审判定通过」的结果状态。 */
export const ACCEPT_STATUSES = new Set([
  'completed-clean',
  'completed-findings',
  'completed-text',
  'no-changes',
]);

/** 明确视为「未通过」的状态（第三方据此抛 REVIEW_FAILED / REVIEW_INTERRUPTED）。 */
export const REJECT_STATUSES = new Set([
  'failed',
  'interrupted',
  'invalid-output',
  'stale',
  'partial',
]);

export function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
}

export function journalDir() {
  return path.join(dshHome(), 'code-review');
}

export function journalPathFor(agentId) {
  const hash = createHash('sha256').update(String(agentId)).digest('hex');
  return path.join(journalDir(), `${hash}.json`);
}

/**
 * 判定一份 journal 的结论。
 * @returns {'accept'|'reject'|'unknown'} unknown = 没读到或形状不认识
 */
export function interpretJournal(raw) {
  if (!raw || typeof raw !== 'object') return 'unknown';
  if (raw.state === 'running') return 'reject'; // 还在跑 = 本轮没有完成评审
  if (raw.state !== 'finished') return 'unknown';
  const status = raw.result && typeof raw.result === 'object' ? raw.result.status : undefined;
  if (typeof status !== 'string') return 'unknown';
  if (ACCEPT_STATUSES.has(status)) return 'accept';
  if (REJECT_STATUSES.has(status)) return 'reject';
  return 'unknown';
}

/**
 * 读并判定。读不到一律 unknown（交给上层按 fail-open 处理，
 * 不把「读不到」当成「没评审」——那会让只读权限问题变成收不了工）。
 */
export async function readJournal(agentId, deps = {}) {
  const readFileImpl = deps.readFile ?? readFile;
  const file = deps.path ?? journalPathFor(agentId);
  try {
    const text = await readFileImpl(file, 'utf8');
    const raw = JSON.parse(text);
    return { verdict: interpretJournal(raw), path: file, raw };
  } catch {
    return { verdict: 'unknown', path: file, raw: null };
  }
}
