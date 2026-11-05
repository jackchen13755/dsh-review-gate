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
| `volume` | 总改动行数 ≥ 阈值（默认 120） |

**明确不拦**：纯 `.md` 且不含判定/API；纯注释与空白；锁文件、`dist/`、`node_modules/`、`CHANGELOG`；`ignoreGlobs` 命中。

## 自限与放行

- 每回合最多推回 **1** 次；每会话最多 **3** 次（必须有会话级：`payload.turn` 可能缺失，只靠回合计数会被反复重置 —— 这个坑上游插件实测踩到过，被推回 4 次）。
- 预算耗尽时**如实放行**并在日志说明，不静默。
- fail-open 的情形：diff 不可得（非 git 仓 / git 超时）、拿不到会话事件源、工具没装、门禁被关。理由：**「永远无法收工」比「漏检一次」更糟**。
- 子 agent 默认不单独拦 —— 它的改动会进入同一个 `git diff`，主会话收尾时按整体判定已覆盖。只在子 agent 用独立 worktree 时打开 `gateSubagents`。

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

配置写在 `cordis.patch.yml` 的 `config` 段，可调项：`gate`、`gateMaxSteersPerTurn`、`gateMaxSteersPerSession`、`removalThreshold`、`volumeThreshold`、`gateSubagents`、`ignoreGlobs`、`extraTriggerGlobs`、`timeoutMs`。

## 测试

```bash
npm test
```

`node --test` 直跑，零依赖、无构建步骤。覆盖 7 类边界输入、四个谎报场景、以及「只验一边等于只锁半扇门」的正反双断言。

## 已知边界（不假装解决）

- **非 git 仓库不拦**：没有 diff 就没有判据，门禁 fail-open。
- **评审质量不归它管**：调了工具但评得很差，这是 reviewer 模型与第三方插件的能力问题。
- **模型可以谎报**：它拦的是「没有事实支撑的声称」，不是「有事实支撑的糟糕判断」。
- **CSS / 运行时行为**：静态 diff 判据看不到。

## License

MIT
