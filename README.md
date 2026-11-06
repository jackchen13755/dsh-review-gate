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

### 两个评审工具不等价：`dsh_code_review` 是主干，`review_brief` 只能补位

`dsh_code_review` 会 spawn 一个独立的 reviewer 子 Agent，结论独立；`review_brief` 是本插件自带的退路，它**只把准则与 diff 摆出来，审查由调用者自己完成**（见 `lib/brief.js` 首段）。拿后者交差，本质是自审。

所以判定时按「本会话有没有前者可用」分流。可用性的判据是**本会话里成功跑通过** `dsh_code_review`（有 `tool/call` 且有成功结果）：

- 用「成功过」而不是「出现过」：一次失败的调用同样会留下 `tool/call`，若据此判 weak-tool，就会把 agent 推回去用一个刚刚失败的工具——越推越死。
- 宁可漏判也不误伤：没调用过、每次都失败、或宿主不落结果，都归为「不可用」，此时 `review_brief` 是唯一退路。

| 情形 | 判定 | 为什么 |
|---|---|---|
| 真调了 `dsh_code_review` | 通过（`ok`） | 主干路径 |
| 调了 `review_brief`，且本会话有前者 | **拦，`weak-tool`** | 有独立评审却用自审顶替 |
| 调了 `review_brief`，本会话从未出现前者 | 放行，标 `brief-self-review` | 部分子会话（如专家子会话）不加载前者，拦了会把人卡死 |

`brief-self-review` 是**如实标注**而不是等价通过：它不会记成 `ok`，在 `review_gate_status` 里能看出这次是自审。

### 「确认没改」与「取证坏了」必须能区分

取证成功、但文件清单为空（git 干净，或降级取证没看到写入）时，状态记 `skipped: 'no-diff-evidence'`，并带 `noChange: true` 与 `source: 'git' | 'observed'`。

放行行为不变（纯讨论回合不能被卡死），但外部能一眼分清三种情形：

| 状态 | 含义 |
|---|---|
| `skipped: 'no-diff'` | 两条取证都拿不到（非 git 且本会话没写过文件） |
| `skipped: 'no-diff-evidence'` | 取证成功，确实没有改动 |
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
- 子 agent **默认也单独拦**（`gateSubagents: true`）。理由：子 agent 完全可能自己改配置或安全相关文件，而主会话的观察记录里**没有**它的 write（非 git 目录下尤其如此）——这个组合曾经是盲区。代价是同一份改动可能被子 agent 与主会话各判一次、多花一次评审，用 `gateMaxSteersPerSession` 兜住；预算按会话独立计量，子 agent 不会占用主会话额度。想省评审费可以关掉，但要知道盲区会回来。

## 关闭

```yaml
# cordis.patch.yml 的 config
gate: false
```

或环境变量 `DSH_REVIEW_GATE=0`。

**刻意不提供模型可调用的 skip 工具** —— 那等于把门禁钥匙交给被门禁约束的人。

## 状态查看

`review_gate_status`（只读）：最近一次判定的原因、触发规则、预算余量、已评审摘要前缀。它不改变任何状态。

## 安装

```bash
dsh plugin add github:jackchen13755/dsh-review-gate
```

本地开发：

```bash
dsh plugin add link:/path/to/dsh-review-gate
```

配置写在 `cordis.patch.yml` 的 `config` 段，可调项：`gate`、`gateMaxSteersPerTurn`、`gateMaxSteersPerSession`、`removalThreshold`、`volumeThreshold`、`gateSubagents`、`reviewAnyCodeChange`、`canaryShadow`、`ignoreGlobs`、`extraTriggerGlobs`、`timeoutMs`。

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
