/**
 * 评审取证：把「要评审什么」整理成一份可直接阅读的简报，交给**调用者自己**判断。
 *
 * 为什么不做成「spawn 一个子 Agent 去审」：那样就依赖 subagents 服务，
 * 而实测 agency 专家子会话不提供该服务 —— 第三方 @michengai/dsh-code-review 正是因为
 * inject 了 subagents/userQuestions 而在专家上下文里不激活，工具直接消失。
 * 本插件只依赖 tools，因此在任何上下文里都能加载；代价是审查由调用者完成，
 * 而不是交给一个独立的 reviewer 子 Agent（这一点必须在工具描述里说清，不能假装等价）。
 */

/** 每个文件最多展示多少行增删，避免简报本身撑爆上下文。 */
const MAX_LINES_PER_FILE = 60;
const MAX_FILES_SHOWN = 40;
const MAX_BRIEF_BYTES = 48 * 1024;

function clipLines(lines, max) {
  const arr = Array.isArray(lines) ? lines : [];
  if (arr.length <= max) return { shown: arr, hidden: 0 };
  return { shown: arr.slice(0, max), hidden: arr.length - max };
}

function fmtFile(f) {
  const label = f.status === 'A' ? '新增' : f.status === 'D' ? '删除' : f.status === 'R' ? '重命名' : '修改';
  const out = [`### [${label}] ${f.path}`];
  const add = clipLines(f.added, MAX_LINES_PER_FILE);
  const del = clipLines(f.removed, MAX_LINES_PER_FILE);
  if (add.shown.length > 0) {
    out.push('```diff');
    for (const l of add.shown) out.push(`+${l}`);
    for (const l of del.shown) out.push(`-${l}`);
    out.push('```');
  }
  if (add.hidden > 0) out.push(`（另有 ${add.hidden} 行新增未展示）`);
  if (del.hidden > 0) out.push(`（另有 ${del.hidden} 行删除未展示）`);
  return out.join('\n');
}

/** 按改动类型给出该重点看什么 —— 清单随触发原因变化，不是固定模板。 */
export function checklistFor(reasons) {
  const r = new Set(Array.isArray(reasons) ? reasons : []);
  const items = [];
  if (r.has('structural')) {
    items.push('模块边界：新增/删除文件是否合理？有没有更小的改法？与现有模块的依赖方向是否清晰、有无循环？');
  }
  if (r.has('config')) {
    items.push('配置/契约：字段是否有默认值与校验？会不会让某条路径静默失效？改动是否向后兼容？');
  }
  if (r.has('security')) {
    items.push('安全：新增的路径是否绕过鉴权/校验？有无把敏感信息写进日志或返回值？');
  }
  if (r.has('decision')) {
    items.push('判定逻辑：每条分支是否可达？未知输入是保守处理还是被当成已知？名单是否由命令枚举而非凭记忆？');
  }
  if (r.has('public-api')) {
    items.push('公共接口：签名变更是否要同步调用方与文档？有无破坏兼容？');
  }
  if (r.has('deletion')) {
    items.push('删除：被删的文件/代码是否还有引用？有没有把还在用的东西一起删掉？');
  }
  if (r.has('volume')) {
    items.push('规模：改动这么大，是否应该拆分？有没有顺手夹带的无关改动？');
  }
  if (items.length === 0) {
    items.push('正确性、边界输入、错误处理，以及与既有约定的风格一致性。');
  }
  // 两条万金油，任何时候都值得看
  items.push('边界输入：空值 / undefined / 单个合法值 / 合法值+非法值，各跑一遍会怎样？');
  items.push('验证载体：这次改动靠什么证明是对的？那个证据能不能红一次？');
  return items;
}

/**
 * 渲染一份评审简报。
 * @param {{ available: boolean, files?: any[], totals?: any, reason?: string, partial?: boolean }} snapshot
 * @param {{ reasons?: string[], note?: string }} [opts]
 */
export function renderBrief(snapshot, opts = {}) {
  const reasons = Array.isArray(opts.reasons) ? opts.reasons : [];
  const note = typeof opts.note === 'string' ? opts.note.trim() : '';

  if (!snapshot || snapshot.available !== true) {
    return [
      '# 评审取证：拿不到改动',
      '',
      `原因：${snapshot?.reason || '未知'}`,
      '',
      '这个目录不是 git 仓库，或 git 取不到 diff。请改用其它方式说明你改了什么，',
      '并在结论里明确写出「未能获取 diff」，不要当作已完成评审。',
    ].join('\n');
  }

  const files = Array.isArray(snapshot.files) ? snapshot.files : [];
  const totals = snapshot.totals || { added: 0, removed: 0 };

  if (files.length === 0) {
    return '# 评审取证：没有未提交改动\n\n工作区干净，无需评审。';
  }

  const shown = files.slice(0, MAX_FILES_SHOWN);
  const parts = [
    '# 评审取证',
    '',
    `- 文件数：${files.length}${snapshot.partial ? '（降级模式：仅依据会话写过的文件路径）' : ''}`,
    `- 增删：+${totals.added} / -${totals.removed}`,
    `- 触发原因：${reasons.length > 0 ? reasons.join(' / ') : '（未提供）'}`,
    note ? `- 额外要求：${note}` : '',
    '',
    '## 改动',
    '',
    shown.map(fmtFile).join('\n\n'),
    files.length > shown.length ? `\n（另有 ${files.length - shown.length} 个文件未展示）` : '',
    '',
    '## 请逐条回答',
    '',
    checklistFor(reasons).map((t, i) => `${i + 1}. ${t}`).join('\n'),
    '',
    '---',
    '取证到此为止。**审查由你（调用者）完成**，本工具不会替你生成结论，也不 spawn 子 Agent。',
    '若发现问题，请直接改代码；改完后如仍命中规则，收尾时会被再次要求评审。',
  ];

  let text = parts.filter((p) => p !== '').join('\n');
  if (text.length > MAX_BRIEF_BYTES) {
    text = `${text.slice(0, MAX_BRIEF_BYTES)}\n\n（简报已截断：改动过大，建议分批评审）`;
  }
  return text;
}
