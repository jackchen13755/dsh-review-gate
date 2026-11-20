# dsh-review-gate

> 回合结束强制评审门禁 · A completion gate that makes code review actually happen

DSH（DeepSeek Harness）插件。当一轮改动命中「判定类 / 配置类」等高风险特征、而这一轮**并没有真正做过评审**时，它会在回合结束的检查点上把 agent 拉回一步，要求先评审再收工。

**核心约束：不修改任何第三方插件。** 判定依据全部来自只读观测。

## 为什么要它

提示词里写着「必须评审」不等于会发生评审。实测同一台机器上：主会话 + 11 个子 agent，当时的评审工具**在工具 schema 里、被调用 0 次**；系统提示里写着 `PRIMARY TOOL … MUST` 的另一个工具，同样是 0 次。

**提示词层的措辞不产生行为。** 唯一不依赖模型自觉的层是机械门禁 —— 这就是本插件。

## 它怎么判「本轮是否已评审」

四个条件同时成立才算：

| # | 条件 | 依据 | 防哪种谎 |
|---|---|---|---|
| 1 | 本回合**主会话**调用过 `summon_expert` / `summon_experts` 且点名「代码审查工程师」 | 会话日志的 `tool/call`（宿主写的事实，不可伪造） | 嘴上说评审过 / 手写报告伪造 |
| 2 | 该次调用没有失败 | `tool/result` 的错误信号 | 调了但评审挂了 |
| 3 | 第三方 journal 若存在则不能是 reject | `$DSH_HOME/code-review/<sha256(agent.id)>.json` | `finished` 但 `result.status:'failed'` |
| 4 | 评审之后没有再改代码 | 自算的 `git diff` 摘要比对 | 评审完又偷改一行 |

条件 1 是主判据（不可伪造），条件 3 只是交叉校验 —— journal 是普通 JSON，模型有 `write` 工具就能编，所以它**不单独成立**。

### 两个实测坑

- `state: 'finished'` **不等于**评审成功：第三方在结果失败时也是先写 `finished` 再抛错。必须看 `result.status`。
- 它的 `fingerprint` 字段只在类型声明里出现过，运行期从未赋值。所以本插件自己算摘要，不依赖它。

## 什么时候触发

命中任一即拦：

| 规则 | 判据 |
|---|---|
| `config` | `package.json`、`*.config.{js,ts,mjs,cjs}`、`cordis.patch.yml`、`Dockerfile`、根级或 `.github/`、`k8s/` 下的 yml/json |
| `decision` | 新增行含判定表达式：`.every/.some/.filter/.includes`、`new Set(`、`if (`、`switch (`、三元 |
| `cross-module` | 非文档改动分布在 ≥2 个不同首段目录 |
| `security` | 路径含 `auth/secret/token/crypto/credential/permission/guard` |
| `public-api` | 新增或删除行命中 `export function/interface/type/const/class` |
| `deletion` | 删除了文件，或删除行数 ≥ 阈值（默认 20） |
| `structural` | **新增或删除代码文件**（= 动了模块边界），除评审外还要求跑 `lens` |
| `volume` | 总改动行数 ≥ 阈值（默认 120） |
| `code` | **兜底**：改动里有非注释的代码变更（纯注释 / 纯文档 / 空改动放行）。上面七条回答「哪里最危险」，它回答「哪里改了」 |

### 为什么需要 `code` 这条兜底

七条规则只覆盖「最危险的改动」，不覆盖「改了代码」本身。实测反馈：只改一两行的回合一条规则都不命中，门禁一声不响，用户只能手动开评审（某会话的日志就是 `skipped=- / reasons=` 全空）。

规则的精确度应该体现在**清单**上，而不是体现在「要不要介入」上——所以补一条兜底：只要不是纯注释/纯文档改动就要求评审。觉得吵可以用 `reviewAnyCodeChange: false` 关掉，退回「只在命中七条规则时评审」的旧行为。

注：注释判定按文件类型区分。JS/TS/CSS 里的 `#` 是私有字段和 id 选择器（代码），只有 `.py`/`.sh`/`.yml` 一类文件里 `#` 才是注释——一刀切会把这类改动当成注释静默放行。

### 结构性改动为什么额外要求 `lens`

新增/删除代码文件等于动了模块边界，而「模块划分是否合理」**从单个文件里看不出来**，只能从依赖图上看。所以这一类除了专家评审，还要求本回合跑过 `lens`（`impact` / `circular` / `metrics`），否则判定为未评审（`no-lens`）。

依据是实测：`lens` 的工具描述里写着 PRIMARY TOOL、系统提示里也有 MUST 段落，但主会话 + 11 个子 agent 调用数为 **0**。写「应该用」不产生行为，把它变成流程里绕不过去的一步才行。

lens 调用**失败不算数**（与评审同样要求成功）；非结构性改动不受影响，避免变成噪音。

**明确不拦**：纯 `.md` 且不含判定/API；纯注释与空白；锁文件、`dist/`、`node_modules/`、`CHANGELOG`；`ignoreGlobs` 命中。

### 评审载体：主会话召唤「代码审查工程师」专家

2026-11-16 起评审入口只剩一条：**主会话**调用 `summon_expert("代码审查工程师", 任务书)`
（或 `summon_experts` 批量里含该专家）。第三方 `@michengai/dsh-code-review` 已从 desktop profile
卸载，`dsh_code_review` 工具与 `/review` 命令**都不存在了**——旧 README 教的那两条路已经走不通。

证据形态（`lib/review-expert.js`，纯函数、有边界输入单测）：

| 判据 | 规则 | 为什么 |
|---|---|---|
| 工具名 | `summon_expert` / `summon_experts`（含 `mcp__x__…` 命名空间变体；**不**做子串匹配） | 相似名字（`summon_expert_v2`）不能被当成评审入口 |
| 专家名 | 精确别名：`代码审查工程师` / `engineering-code-reviewer` / `code-reviewer` / `engineering/code-reviewer` | 名字里带这几个字的别的东西（如「代码审查工程师助理」）不算 |
| 批量 | `summon_experts` 里**任一位**是该专家就算 | 批量就是并发跑，评审真的发生了；要求「再单独叫一次」只会罚合理的批量 |
| 结果 | 该次调用必须有成功结果 | 调了但挂了 / 没结果都不算（`call-failed` / `call-unresolved`） |
| 发起方 | **主会话** | 子 Agent 的评审只当材料，不计入门禁证据 |
| 新鲜度 | 评审之后不能再改代码（diff 摘要比对） | 审完又改 → `stale` |

**已不适用（仅保留兼容，不再推荐）**：旧插件曾把评审报告作为用户消息注入会话
（`source.kind = 'michengai-code-review'`）。本机不会再产生这类事件，`lib/review-report.js`
留着只为「以后装回插件」时不把已评审误判成未评审。

### 判定矩阵（每条都有正反断言）

`tests/review-expert-evidence.test.js` 与 `tests/review-expert.test.js` 把下面这些格子逐个喂进去：

| 输入 | 判定 | 备注 |
|---|---|---|
| 空 events / 没有 `tool/call` | 拦（`no-call`） | 正向对照：同样 diff 换成一次成功的专家评审 → 放行 |
| 事件源不可得（session 缺失） | 放行 | `skipped: 'no-events'`，与「门禁坏了」可区分 |
| `summon_expert("UI 设计师")` 成功 | 拦（`no-call`） | 叫了别的专家不等于评审 |
| `summon_expert("代码审查工程师")` 成功 | 放行（`ok`） | 中文名与三种 slug 都被认 |
| `summon_experts` 批量含审查工程师 | 放行（`ok`，`reviewTool: 'summon_experts'`） | 批量里只有别的专家 → 拦 |
| 调用成功但结果 `isError` | 拦（`call-failed`） | 必须与「没调用」区分：排查方向不同 |
| 宿主要记结果、但这条没有结果 | 拦（`call-unresolved`） | 宿主根本不记结果时按调用事实算 |
| 评审后又改代码（digest 变） | 拦（`stale`） | 重审一次（新 callId）即放行 |
| 子 Agent 发起的 summon | 不判（不 steer、也不记 `reviewed: true`） | 主会话不能继承子 Agent 的评审 |

**能红一次**：把 `lib/review-expert.js` 的工具名判据改回只认 `dsh_code_review`，上面 9 条「专家评审 → 放行」的断言全红；
`mutants.json` 里另有两条变异体（`review-expert.alias-match` / `review-expert.tool-name`）钉住「放宽判据」与「放开工具名」两个退化方向，
由 `tests/canary/review-expert.test.js` 的具名断言杀死（`canary_verify` 可复跑）。

### 子 Agent 守卫：只拦「指向审查工程师」的那一种召唤

`lib/review-tool-policy.js` 的守卫对象变了：旧版拦 `dsh_code_review` 工具名（该工具已不存在，继续拦就是死逻辑），
现在拦 **`summon_expert` / `summon_experts` 且 `expert` 指向代码审查工程师** 的调用。

- 子 Agent 里这种调用会被 `ctx.tools.guard()`（或 `tools/pre-execute` 兜底）直接拒绝，
  理由串以 `recursion-cut: ` 开头、并给出下一步（「交回主会话评审」）——可 grep 取证。
- **不拦别的专家**：`summon_expert("UI 设计师")` 在子 Agent 里完全合法，否则队友就再也叫不到任何专家。
- **看不到 arguments 时放行**：无法证明它叫的是审查工程师，宁可漏拦一次，也不能误杀所有专家调用。
- 为什么需要它：审查工程师会起独立审查子 Agent，审查子继承全局 `AGENTS.md` 的「开工先叫人 / 交付前跑一次评审」，
  可能反过来再召唤同一专家 → 再起审查子 → 成环（实测跑到 `delegationDepth=4`）。
- 刻意**不做** `restrict()` 自愈：`summon_expert` 是共享工具（同一个还能叫别的专家），摘掉它会把合法用途一起废掉。

### 「确认没改」与「取证坏了」必须能区分

取证成功、但文件清单为空（git 干净，或降级取证没看到写入）时，状态记 `skipped: 'no-diff-evidence'`，并带 `noChange: true` 与 `source: 'git' | 'observed'`。

放行行为不变（纯讨论回合不能被卡死），但外部能一眼分清三种情形：

| 状态 | 含义 |
|---|---|
| `skipped: 'no-diff'` | 两条取证都拿不到（非 git 且本会话没写过文件） |
| `skipped: 'no-diff-evidence'` | 取证成功，确实没有改动 |
| `skipped: 'already-reviewed'` | 这版 diff 已经评审过（摘要相同），无需重复评审 |
| `skipped: 'gate-error'` | 门禁自己在判定中抛错并放行；`error` 字段带一句原因 |
| 无 `skipped` 字段 | 门禁正常跑过并按规则判定 |

在此之前，后两种在状态里都是 `reviewed: false` + `files: 0`，和「门禁根本没运行」长得一样——这正是最难查的一类静默故障。

## 非 git 目录下的降级取证

门禁优先用 `git diff` 取证。当目录不是 git 仓库（或 git 取不到 diff）时，**降级**为「本会话实际写过的文件」：包装 `tools/execute`，只在 `edit` / `write` **成功**时记录路径。

降级模式的能力边界（如实说明，不假装等价）：

| 能力 | git 模式 | 降级模式 |
|---|---|---|
| 配置/契约类文件 | ✅ | ✅ |
| 安全敏感路径 | ✅ | ✅ |
| 跨模块改动 | ✅ | ✅（路径按 cwd 相对化后判定） |
| 判定表达式 / 公共 API | ✅ | ❌ 没有增删行，无法判定 |
| 删除量 / 总规模 | ✅ | ❌ 同上 |
| 新鲜度（评审后又改） | ✅ diff 摘要 | ✅ 读文件内容算摘要 |

降级时 `files[].added` 故意留空——**不拿全文冒充「新增行」**，否则文件里本来就有 `if (` 会让判定表达式规则大面积误触发。触发时的 steer 文本会明确写出「本次取证为降级模式」。

两条都取不到（既非 git、本会话也没写过文件）时仍然 fail-open，并在 `review_gate_status` 里记为 `skipped: 'no-diff'` 且带上 `observedWrites` 计数——**让「按设计放行」和「插件坏了」可以区分**。

## 自限与放行

- 每回合最多推回 **1** 次；每会话最多 **3** 次（必须有会话级：`payload.turn` 可能缺失，只靠回合计数会被反复重置 —— 这个坑上游插件实测踩到过，被推回 4 次）。
- 预算耗尽时**如实放行**并在日志说明，不静默。
- fail-open 的情形：diff 不可得（非 git 仓 / git 超时）、拿不到会话事件源、工具没装、门禁被关。理由：**「永远无法收工」比「漏检一次」更糟**。
- 子 agent **一律不参与门禁**（契约，不是开关）：评审证据只认主会话的调用，子 Agent 的评审只当材料——再拦只会把它推进一个永远满足不了的要求（无限推回）。子 agent 的改动由主会话收口时统一评审。旧配置项 `gateSubagents` 已删除，避免「配置说开、实际不开」。

## 关闭

```yaml
# cordis.patch.yml 的 config
gate: false
```

或环境变量 `DSH_REVIEW_GATE=0`。

**刻意不提供模型可调用的 skip 工具** —— 那等于把门禁钥匙交给被门禁约束的人。

## 状态查看

`review_gate_status`（只读）：最近一次判定的原因、触发规则、预算余量、已评审摘要前缀。它不改变任何状态。

## 陪审团（M5，默认关闭）

三席固定：`fact`（事实派）/ `opposition`（反方派）/ `gap`（缺口派）。每人投一票，
判决层（`lib/jury.js`，纯函数）做多数决：

| 聚合判决 | 条件 | 是否放行 |
|---|---|---|
| `pass` | pass 票达到门槛 `floor(n/2)+1`（三席取 2）**且三席齐备** | ✅ 唯一放行态 |
| `fail` | fail 票达到多数门槛 | ❌ |
| `topped` | ≥2 票 `insufficient` 且其中 ≥2 票 `boundary='external'`（问题超出可评审边界，多数决不适用） | ❌ |
| `unclear` | 有效票全为 `undecidable`，或没有判决达到多数门槛 | ❌ |
| `unavailable` | 无有效票 / 票非法 / 票没投满三席 / 票与当前 diff 摘要不一致 / 读不到票箱 | ❌ |

开关（默认全关；`enabled=false` 时连工具都不注册）：

```yaml
jury:
  enabled: true       # 注册 jury_vote / jury_status，开始读票箱
  requireJury: true   # 把票型并入判决：通过 = 既有判定通过 ∧ jury pass
```

- `jury_vote`：主会话登记一票。**每票必须绑证据与版本**：
  - `basisKind` / `basisRef`（必填）：`expert` = 本会话一次**成功**的「代码审查工程师」调用 `callId`；
    `canary` = 一份 `verified` 变异检定回执里的被杀变异体 id（或 `verified`）；
    `file` = 本会话**写过**的文件路径（相对仓库根或绝对路径）。指认不到一律拒收。
  - **`pass` 票只接受 `expert` 证据**：`file` / `canary` 只能说明「我看过 / 我跑过」，
    说明不了「我同意放行」，它们只允许支撑 `insufficient` / `fail`。
  - **三票必须指认三个不同的、本回合发生的事实**：`basis.ref` 重复（同一个 `callId` /
    同一个文件，绝对与相对写法也算同一个）→ `unavailable`；`expert` 调用还必须发生在
    门禁采到这版 diff 摘要的那一回合或之后，上一版 diff 的旧调用不能给这一版投票。
    这就是「三个视角」在实现里的真实含义：三条彼此不同、本回合可核验的证据，而不是三次工具调用。
  - 票自动绑上门禁算出的**当前 diff 摘要**（不接受调用方自报），页面上看不到这个参数。
    **票必须等门禁采到本回合 diff 摘要后才能投**：拿不到摘要一律拒收（见下方「恢复路径」）。
  - `action=status` 只读查看，`action=reset` 清空。同一角色再投 = 改票。
- `jury_status`：只读查看当前票型、每票绑定的证据/摘要与聚合判决。
- 票箱：`$DSH_HOME/review-gate/jury/<sha256(sessionId)>.json`（**不是**第三方 code-review 的 `$DSH_HOME/code-review/`，那个目录只读）。
- **票必须和当前这版 diff 对得上**：任何一票的摘要与当前不同（含没有摘要的旧票），整份票型判 `unavailable`——
  上一版的 pass 不能拿去放行改了之后的代码。同一 digest 的后续取证**不会**让已投的票失效
  （「这版 diff 从哪回合存在」取首次观察回合，不是最后一次看它的回合）。
- **坏票 = 整份票型不可用**：票箱里出现一张非法票时不做「静默丢弃」（否则 `[pass,pass,坏,pass]` 会被读成 3 张好票），
  门禁判 `unavailable`，需 `jury_vote(action:'reset')` 后重投。
- 票型只在**确实用它放行**之后消费（三席齐备 + `requireJury=true` + 命中触发规则 + 非运维回合）：
  运维回合与 denied 回合不吃票（denied 的票已绑摘要，代码改了自然对不上）。
- `requireJury=true` 但 `jury.enabled` 未开时会 `console.warn` 一次并忽略 `requireJury`——
  「以为在拦、实际没拦」是本插件最反对的失效形态。
- `requireJury=false`（或 `enabled=false`）时 `decideReview` 的返回**逐字段不变**，既有测试与旧行为不受影响。

**恢复路径（第一次投票常见）**：如果 `jury_vote` 回「缺少 digest……门禁还没有可用的 diff 摘要」，
说明本会话还没被门禁取证过（插件刚加载 / 这一轮还没结束）。先让门禁跑过一轮（回合结束时的
turn-stopping，或下一步的 pre-step 会采到 diff），再重新投票即可；**不要**自己伪造摘要，
工具不接受调用方自报的 digest。

## 提示词里的工作流约定（R16–R18）

插件往**每个会话**的系统提示注入一段约定（`lib/index.js` 的 `REVIEW_FIRST_PROMPT`）。除「什么改动要评审」「谁去发起评审」，还钉了三条工作流：

| 规则 | 要求 |
|---|---|
| R17 大需求先拆 | 接到大需求先尝试拆成**彼此独立**的子任务；**拆不动**（强依赖、必须串行、要改同一批文件）才自己顺序做，并说明为什么拆不开 |
| R18 并行子 agent | 拆分完成后（或一开始就是多个独立任务）在**同一条消息里并行启动**多个 `subagent` / `summon_experts`，不排队等；**写作用域互不重叠**，否则并行的子 agent 会互相覆盖文件 |
| R16 复审窄化 | 按评审意见改完后，复审只覆盖修复涉及的文件/行，**不做全量重审**；窄范围由 `review_gate_status` 的 `reviewScope` 给出，按它来。`reviewScope` 为 `null` ＝ **本轮没有可用基线**（首次评审 / 换了仓库 / 基线被淘汰）→ 按全量审，**不要沿用上一轮的窄范围**（它会指向已不在 diff 里的文件，而真正改了的反而漏审） |

这三条是写给 agent 的**行为约定**，不是门禁判据：它们不改变「本轮是否已评审」的判定，只决定 agent 怎么派活、复审该看哪里。

**另加一条边界（2026-11-11）：「评审归主会话」不等于「干活也只能主会话做」。** 用户说「不用评审」「只用主 agent review 一下」「你 review 下就行」时，它只限制**评审由谁发起**（评审仍留在主会话），**不限制干活**：该拆的实现照拆、该并行照并行。只有用户**明确**说「整件事都在主会话里做」「不要开子 Agent」时才全部自己干——用户明确要求优先（以用户为准）。判据一句话：看用户限的是「评审」还是「干活」，限评审不影响拆分，限干活才不派单。
（起因：真实事故里主 agent 把「这个不用评审，只用主 agent review 下」读成了「连实现也归主会话」，3 个文件 8 次编辑全自己做完，一个子 agent 都没开。）

## 安装

```bash
dsh plugin add github:jackchen13755/dsh-review-gate
```

本地开发：

```bash
dsh plugin add link:/path/to/dsh-review-gate
```

配置写在 `cordis.patch.yml` 的 `config` 段，可调项：`gate`、`gateMaxSteersPerTurn`、`gateMaxSteersPerSession`、`removalThreshold`、`volumeThreshold`、`reviewAnyCodeChange`、`canaryShadow`、`jury`、`ignoreGlobs`、`extraTriggerGlobs`、`timeoutMs`。

两个容易误读的点：

- **预算按检查点分桶**：`gateMaxSteersPerSession` 是「每个检查点」的额度，`turn-stopping` 与 `pre-step` 各一份（`pre-step` 需要独立额度，否则回合进行中被卡死），所以真实上限最多是 2×N。预算耗尽时会写 `reason: budget-exhausted` 并在诊断日志留痕，不再静默。
- **`canaryShadow`**：变异检定（`canary_verify`）目前只把结果记进状态，**不参与放行**。先观察误伤与伪造情况，再谈武器化。

## 测试

```bash
npm test
```

`node --test` 直跑，零依赖、无构建步骤。覆盖 7 类边界输入、四个谎报场景、以及「只验一边等于只锁半扇门」的正反双断言。

## 已知边界（不假装解决）

- **非 git 仓库不拦**：没有 diff 就没有判据，门禁 fail-open。
- **评审质量不归它管**：调了工具但评得很差，这是 reviewer 模型与第三方插件的能力问题。
- **模型可以谎报**：它拦的是「没有事实支撑的声称」，不是「有事实支撑的糟糕判断」。
- **`bash` 里改的文件看不见**：降级模式只认 `edit` / `write` 工具调用，`sed -i`、`cat >` 之类的方式绕过了观察。
- **CSS / 运行时行为**：静态 diff 判据看不到。

## License

MIT
