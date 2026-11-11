# dsh-review-gate

> 回合结束强制评审门禁 · A completion gate that makes code review actually happen

DSH（DeepSeek Harness）插件。当一轮改动命中「判定类 / 配置类」等高风险特征、而这一轮**并没有真正做过评审**时，它会在回合结束的检查点上把 agent 拉回一步，要求先评审再收工。

**核心约束：不修改任何第三方插件。** 判定依据全部来自只读观测。

## 为什么要它

装了 `dsh_code_review` 不等于会用。实测同一台机器上：主会话 + 11 个子 agent，该工具**在工具 schema 里、被调用 0 次**；连「代码审查工程师」专家自己也没调。而在系统提示里写着 `PRIMARY TOOL … MUST` 的另一个工具，同样是 0 次。

**提示词层的措辞不产生行为。** 唯一不依赖模型自觉的层是机械门禁 —— 这就是本插件。

## 它怎么判「本轮是否已评审」

四个条件同时成立才算：

| # | 条件 | 依据 | 防哪种谎 |
|---|---|---|---|
| 1 | 本回合调用过 `dsh_code_review` | 会话日志的 `tool/call`（宿主写的事实） | 嘴上说评审过 / 手写 journal 伪造 |
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

新增/删除代码文件等于动了模块边界，而「模块划分是否合理」**从单个文件里看不出来**，只能从依赖图上看。所以这一类除了 `dsh_code_review`，还要求本回合跑过 `lens`（`impact` / `circular` / `metrics`），否则判定为未评审（`no-lens`）。

依据是实测：`lens` 的工具描述里写着 PRIMARY TOOL、系统提示里也有 MUST 段落，但主会话 + 11 个子 agent 调用数为 **0**。写「应该用」不产生行为，把它变成流程里绕不过去的一步才行。

lens 调用**失败不算数**（与评审同样要求成功）；非结构性改动不受影响，避免变成噪音。

**明确不拦**：纯 `.md` 且不含判定/API；纯注释与空白；锁文件、`dist/`、`node_modules/`、`CHANGELOG`；`ignoreGlobs` 命中。

### 评审载体：`dsh_code_review` 工具（或用户敲 `/review`）

主判据是**工具调用**：`dsh_code_review` 已恢复为模型可调用的工具，由 agent 自己发起评审。
它同时提供斜杠命令 `/review`、`/review-cancel`、`/review-status`，由**用户**触发。两条路都算证据：
工具调用留在会话日志的 `tool/call` 里；命令审查完成后把报告作为用户消息注入会话
（`source.kind = 'michengai-code-review'`，成功以 `Here is the completed code review report` 开头），
这条消息同样由宿主写入会话日志，本插件把两者并列为评审证据。
本插件自带的 `review_brief` 取证工具已于 2026-11-10 **删除**——它只把准则与 diff 摆出来、审查由调用者自己完成，本质是自审。

### 报告识别（2026-11-10 修）：一处字段读错导致反复评审

实测会话 `session-500b6b50`（6 回合、无新增改动）里门禁连发 **5 次** `/review`。原因：
真实报告注入的事件形状是 `{ type:'user/message', data:{ content:[…], source:{kind:'michengai-code-review'} } }`，
而旧实现只认 `data.message.content`，于是「评审已完成」永远识别不到 → 每回合又触发一次。

同时把判据从「只看最后一条报告」改成「**最后一次写文件之后是否出现过成功报告**」：
同一版 diff 被重复评审时（后面几次超时/中止），最后一条可能是失败报告，但 diff 没变，
仍然算覆盖——否则会越失败越重试。

### 需要评审时只写状态，不执行任何命令（2026-11-11 起）

门禁**不执行任何命令**，也不替模型发起评审。判定「需要评审」时它只往 `review_gate_status`
里写状态，交给外部去发起：

| 字段 | 含义 |
|---|---|
| `needsAgentReview: true` | 本回合需要评审（状态标记，不是动作） |
| `reviewRoot` | 按**写入路径**解析出的评审根（见上一节的工作树问题） |
| `sessionCwd` | 会话的**实时**目录（不是 `header.cwd`） |
| `hint` | 一句话说明该做什么：由主会话调 `dsh_code_review` 工具，或你手动跑 `/review` |
| `reviewScope` | 复审时的**窄范围**（修复涉及的文件/行）：按评审意见改完后只审这一片，不全量重审。**为 `null` 表示本轮没有可用基线**（首次评审 / 刚换了仓库 / 基线被淘汰 / 取证失败）→ **按全量审，不要沿用上一轮的窄范围** |

评审的发起方只有两个：**agent 自己**调 `dsh_code_review` 工具；或**用户**亲手敲 `/review`。

废弃的键：`autoReview` / `autoReviewCwd` / `autoReviewInput` / `autoReviewTimeoutMs` 四个键**已废弃**——
保留只为兼容既有配置，传入不产生任何效果（执行路径已不存在）。
早先那条「门禁拿 `ctx.commands.execute` 代跑 `/review`」的路子已删除：它与 agent 自己调工具
会互相叠加（门禁代跑 → 报告回投 → 模型照提示再调一次 → 门禁又判需评审），实测出现无限评审，
由 `tests/no-command-trigger.test.js` 反向断言钉住（`runCommand` 必须 0 次调用）。

推回是独立开关：发布配置 `steer: false`（只记录状态、不推回）；设 `steer: true` 则门禁仍会把
回合拉回一次、要求 agent 去评审。

`dsh_code_review` 只允许在**主会话**调用（`lib/review-tool-policy.js`）：任何子 Agent 里调用都会被 `ctx.tools.guard()` 或 `pre-execute` 直接拒绝（理由串 `recursion-cut: ...`，可用 `DSH_*` 日志 grep 取证）。
原因：该工具会 spawn 独立审查子 Agent，而审查子继承全局 `AGENTS.md` 的「开工先叫人」，可能反过来召唤 Agency 专家；专家又被要求「交付前跑一次评审」→ 再起审查子 → 成环（实测跑到 `delegationDepth=4`）。把工具限制在主会话，环的闭合边就不存在。
这条守卫在 2026-11-11 随自研 fork 重新注册该工具而**重新生效**（此前上游 1.0.9+ 把工具改成斜杠命令，守卫一度没有任何命中点）。

判定只有一条路：**本回合真的调过 `dsh_code_review`**——`tool/call` 加上成功结果，或一条覆盖当前 diff 的 `/review` 报告，才算已评审。

| 情形 | 判定 | 为什么 |
|---|---|---|
| 真调了 `dsh_code_review` | 通过（`ok`） | 主干路径，也是唯一路径 |
| 没调用 `dsh_code_review` | 拦 | 唯一被接受的评审证据 |

评审工具只剩 `dsh_code_review` 一个候选（`lib/gate.js` 的 `REVIEW_TOOLS` 里只有它），所以 `lib/verdict.js` 里**不存在**「自审顶替独立评审」的分支，也没有「工具不可用时改走自审」的退路。
旧版的两件东西都已删除，别再照旧说明写：`review_brief` 取证工具（2026-11-10 删）与 `brief-self-review` 判决原因（已不在 `REASON_TEXT` 的八个原因里）。

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
- 子 agent **一律不参与门禁**（契约，不是开关）：`dsh_code_review` 在子 Agent 里被硬拦，它没有可用的评审载体——再拦只会把它推进一个永远满足不了的要求（无限推回）。子 agent 的改动由主会话收口时统一评审。旧配置项 `gateSubagents` 已删除，避免「配置说开、实际不开」。

## 关闭

```yaml
# cordis.patch.yml 的 config
gate: false
```

或环境变量 `DSH_REVIEW_GATE=0`。

**刻意不提供模型可调用的 skip 工具** —— 那等于把门禁钥匙交给被门禁约束的人。

## 状态查看

`review_gate_status`（只读）：最近一次判定的原因、触发规则、预算余量、已评审摘要前缀。它不改变任何状态。

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

配置写在 `cordis.patch.yml` 的 `config` 段，可调项：`gate`、`gateMaxSteersPerTurn`、`gateMaxSteersPerSession`、`removalThreshold`、`volumeThreshold`、`reviewAnyCodeChange`、`canaryShadow`、`ignoreGlobs`、`extraTriggerGlobs`、`timeoutMs`。

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
