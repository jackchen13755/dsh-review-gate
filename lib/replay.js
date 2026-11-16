/**
 * 重放层：从会话事件里找「本轮是否真的把改动交给代码审查工程师评审」。
 *
 * 这是主判据，因为 tool/call 是宿主写进会话日志的事实，模型无法凭空制造一次
 * 不存在的工具派发。相比「读完成账本的自报证据」和「读模型自己写的报告文件」，
 * 它是唯一不可伪造的那一半。
 *
 * 事件形状（v4，实测自本机 session.v4.jsonl.zstd）：
 *   tool/call   → data.{ turn, step, callId, name, arguments(JSON 字符串) }
 *   tool/result → data.{ turn, step, message: { role:'tool', source:{kind:'tool',callId}, toolCallId, content } }
 *
 * 注意 `tool/call` 自带 `turn` 字段，所以能精确要求「本回合」，而不是「本会话历史上」。
 */

/**
 * 取事件数组。
 * 三种形态按顺序尝试；必须区分「不可得」与「空」——否则一个拿不到事件源的宿主
 * 会被误判成「本轮没评审」，从而永远收不了工。
 */
export function eventsOf(session) {
  if (!session || typeof session !== 'object') {
    return { events: [], available: false, source: '(no session)' };
  }
  for (const fn of ['snapshotEvents', 'ownEvents']) {
    if (typeof session[fn] !== 'function') continue;
    try {
      const out = session[fn]();
      if (Array.isArray(out)) return { events: out, available: true, source: `${fn}()` };
    } catch {
      // 继续试下一个
    }
  }
  if (Array.isArray(session.events)) {
    return { events: session.events, available: true, source: 'events' };
  }
  return { events: [], available: false, source: '(no event source)' };
}

function dataOf(event) {
  return event && typeof event === 'object' && event.data && typeof event.data === 'object' ? event.data : {};
}

function typeOf(event) {
  return event && typeof event === 'object' ? event.type : undefined;
}

/**
 * 归一化调用方点名的工具名集合。
 *
 * ⚠️ **没有默认值**：旧实现把默认值硬编码成 `dsh_code_review`，该工具随第三方插件卸载后，
 * 这个默认值变成「永远匹配不到任何调用」的静默失败——不会报错，只会永远判「没评审」。
 * 所以现在调用方必须显式点名；一个都没点名时返回空集合 = 「不把任何工具当评审证据」。
 * 这是保守方向：宁可要求补一次评审，也不要把不相干的工具当成评审。
 */
function toolNamesOf(opts) {
  const out = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim() !== '' && !out.includes(value)) out.push(value);
  };
  push(opts?.toolName);
  if (Array.isArray(opts?.toolNames)) for (const name of opts.toolNames) push(name);
  return out;
}

/**
 * 找目标工具调用。
 * @param {any[]} events
 * @param {{ toolName?: string, toolNames?: string[], match?: (call: any) => boolean, turn?: number }} opts
 *        turn 为 number 时按回合精确匹配；缺失则退化为整会话匹配（此时靠 digest 新鲜度兜住范围）。
 *        match 是额外的语义过滤（例如「这次 summon_expert 点名的专家是不是代码审查工程师」）。
 */
export function findCalls(events, opts = {}) {
  const names = toolNamesOf(opts);
  const match = typeof opts.match === 'function' ? opts.match : undefined;
  const wantTurn = typeof opts.turn === 'number' ? opts.turn : undefined;
  const out = [];
  if (names.length === 0) return out;
  for (const e of Array.isArray(events) ? events : []) {
    if (typeOf(e) !== 'tool/call') continue;
    const d = dataOf(e);
    if (!names.includes(d.name)) continue;
    if (wantTurn !== undefined && d.turn !== wantTurn) continue;
    const call = { name: d.name, callId: d.callId, turn: d.turn, step: d.step, arguments: d.arguments };
    if (match !== undefined && match(call) !== true) continue;
    out.push(call);
  }
  return out;
}

/**
 * 判断某个 callId 的结果是否成功。
 * @returns {true|false|null} null = 找不到结果（无法判定，交给上层保守处理）
 */
export function resultOkFor(events, callId) {
  if (typeof callId !== 'string' || callId === '') return null;
  let seen = false;
  for (const e of Array.isArray(events) ? events : []) {
    if (typeOf(e) !== 'tool/result') continue;
    const d = dataOf(e);
    const msg = d.message && typeof d.message === 'object' ? d.message : d;
    // 实测形状（本机 session.v4.jsonl.zstd）：join key 在 message.source.callId，
    // message.toolCallId 是同一个值的冗余字段。两个都认，避免某一版只留一个。
    const src = msg.source && typeof msg.source === 'object' ? msg.source : {};
    const id = src.callId ?? msg.callId ?? msg.toolCallId ?? d.callId ?? d.toolCallId;
    if (id !== callId) continue;
    seen = true;
    // 各种可能的失败信号，任一命中即判失败
    if (msg.isError === true || d.isError === true) return false;
    if (msg.error || d.error) return false;
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const part of content) {
      const text = part && typeof part === 'object' ? String(part.text ?? '') : String(part ?? '');
      if (/REVIEW_FAILED|REVIEW_INTERRUPTED|^\s*Error:|审查失败|审查中断/.test(text)) return false;
    }
  }
  return seen ? true : null;
}

/**
 * 宿主是否会落 tool/result。
 *
 * 为什么需要它：如果宿主压根不记录结果事件，那「找不到 result」是**正常**的，不能据此判失败；
 * 但如果宿主明明会记录、只是这一次没有，那「没有 result」意味着**这次调用没有完成**
 * （回合提前结束 / 还在跑），必须判为未评审。
 * 把这两种情况混为一谈，就是主判据上的静默 fail-open。
 */
export function hostEmitsResults(events) {
  for (const e of Array.isArray(events) ? events : []) {
    if (typeOf(e) === 'tool/result') return true;
  }
  return false;
}

/**
 * 本轮是否有一次「调用且成功」的目标评审调用。
 *
 * @returns {{ seen: boolean, callId?: string, tool?: string, unresolved?: boolean, failed?: boolean }}
 *   seen=false 且 unresolved=true 表示：确实派发了，但没有结果可供判定（且宿主是会记结果的）。
 *   tool 是命中的那个工具名（batch 场景下用来区分 summon_expert / summon_experts，进 status 排障）。
 */
export function reviewCallInTurn(events, opts = {}) {
  const calls = findCalls(events, opts);
  const emits = hostEmitsResults(events);
  let unresolved = false;
  let failed = false;
  const lastTool = calls.length > 0 ? calls[calls.length - 1].name : undefined;

  // 从最新一次调用往前看。turn 缺失时（宿主可以不传 payload.turn）无法按回合过滤，
  // 这时只有「最后一条成功调用」代表 agent 最近那一次评审；取第一条会把
  // 「先成功一次、之后又重审一次」读成同一个旧调用，靠 callId 判先后就永远判不出来。
  for (const c of [...calls].reverse()) {
    const ok = resultOkFor(events, c.callId);
    if (ok === true) return { seen: true, callId: c.callId, tool: c.name, unresolved: false, failed: false };
    // 明确失败 → 不算「已评审」，但必须记下来：调用发生过而失败，和从没调用，
    // 是两种不同的故障，提示语与排查方向也不同（见 verdict 的 call-failed）。
    if (ok === false) { failed = true; continue; }
    // ok === null：找不到结果
    if (!emits) return { seen: true, callId: c.callId, tool: c.name, unresolved: false, failed: false }; // 宿主不记结果，只能按调用事实算
    unresolved = true; // 宿主会记结果却没有 → 这次调用没完成
  }
  return { seen: false, callId: undefined, tool: lastTool, unresolved, failed };
}
