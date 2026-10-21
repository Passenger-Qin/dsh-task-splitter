# dsh-task-splitter

**A DSH host plugin that notices long tasks and splits them before they fail — built for small-context local models.**

[中文说明见下方](#中文说明)

Small local models (llama.cpp / Ollama, e.g. Qwen3 27B at IQ2 with `maxTokens: 8192`) fail long tasks in two
*completely different* ways. This plugin detects both on the **host side** and hands the model an executable
procedure, instead of hoping the model judges its own limits.

| | **Lane A — long output** | **Lane B — long workflow** |
|---|---|---|
| Example | "write a 3000-word industry report, 4 sections" | **"pick me a stock likely to rise tomorrow"** |
| Prompt shape | usually explicit | **often tiny** ("pick me a…") |
| Real bottleneck | the per-request output budget (`maxTokens`) | **step count and context**: tool output floods the window, a small model drifts, intermediate results get lost |
| What this plugin does | scaffolds `tasks/<slug>/parts/NN-*.md` + `MANIFEST.json`; one part per reply, then `assemble` | scaffolds `tasks/<slug>/PLAN.md` + `notes/`; **plan first, one step per reply, results on disk** |

## How it decides

Scoring runs in the host (no model cooperation needed):

- **Lane A signals** — explicit word/char count, explicit part count, numbered section list (used as part titles),
  long-document keywords + a writing verb, very long prompt, multi-deliverable phrasing.
- **Lane B signals** — decision/research verbs (pick / recommend / evaluate / compare / analyse / predict / research / screen)
  **plus** a data-dependent domain noun (stocks, funds, housing, flights, insurance, papers, competitors, laptop…),
  explicit multi-step phrasing, or "needs current external data".
- Single-lookup requests ("what's the weather tomorrow") are deliberately clamped below the threshold.

Examples:

| Prompt | Result |
|---|---|
| `what's the weather` | no split |
| `look up tomorrow's weather for me` | no split (single lookup) |
| `recommend me a movie` | no split (score 2 < 3) |
| **`pick me a stock likely to rise tomorrow`** | **Lane B** → `PLAN.md` + `notes/`, "plan first, one step per reply" |
| `compare these three laptops and pick one` | **Lane B** |
| `write a 3000-word industry report, 4 parts` | **Lane A** → 4-part skeleton |
| a prompt with a 1./2./3. section list | **Lane A** (part titles taken from the list) |

The procedure is injected with `agent/pre-step` **prepended to the very same request** (no extra round trip),
and only for steps that start from a human message.

## Install

```bash
dsh plugin --profile <your-profile> add dsh-task-splitter
```

Restart DSH afterwards. To build from source: `npm pack` then
`dsh plugin --profile <your-profile> add file:./dsh-task-splitter-0.1.0.tgz`.

Requires a DSH host that exposes `agent/pre-step`, `ctx.agents` and `ctx.sessions`
(`@deepseek-ai/dsh-agent` / `dsh-session` `^0.1.1-rc.2 || ^0.2.0-rc.1`).

## Configuration

```yaml
# in your profile cordis patch (or a home patch)
- id: task-splitter
  config:
    enabled: true
    providers: [qwen-local]   # empty array = every provider
    lanes: [parts, plan]      # drop one to disable that lane
    minScore: 3               # Lane A threshold
    workflowScore: 3          # Lane B threshold (raise to 4 to be more conservative)
    maxParts: 8               # Lane A: at most this many parts
    wordsPerPart: 900         # Lane A: target chars per part
    tasksDir: tasks           # relative to the session working directory
    toolPath: ''              # CLI used in the injected rules; defaults to the bundled one
    extraRules: ''            # 追加到注入规程末尾的补充说明（放环境特定的工具名/服务地址）
```

## Bundled CLI

`dsh-task-parts` (also exported as `dsh-task-splitter/task-parts`) drives Lane A outside the model:

```bash
node bin/task-parts.mjs init <taskDir> --title "T" --parts "one|two|three"
node bin/task-parts.mjs status <taskDir>     # ✅/⬜ per part, exits 2 while incomplete
node bin/task-parts.mjs next <taskDir>       # the next part to write
node bin/task-parts.mjs assemble <taskDir>   # concatenates into final.md
```

## Limitations (please read)

- Lane B guarantees **process and honesty** (plan, evidence on disk, sources, uncertainty, "do not fabricate data"),
  **not** the correctness of the answer. A local model with no market/financial data source cannot honestly predict
  tomorrow's stock move — the procedure makes it say so instead of inventing numbers.
- Detection is heuristic. `workflowScore` / `minScore` are the knobs; the plugin never blocks a turn — worst case it
  adds one short instruction message.
- Tested against Windows DSH 0.2.0-rc.2 and 0.2.1-rc.2 hosts (`session.header.cwd`) with llama.cpp-served Qwen3;
  30 offline simulation cases ship in [`test-sim.mjs`](./test-sim.mjs) (not included in the npm tarball).
- **0.1.2 note:** DSH 0.2.1+ moved the session working directory to `session.header.cwd` (no `session.cwd` /
  `session.meta` any more). 0.1.1 and earlier silently skipped every long task on those hosts; 0.1.2 resolves
  `header.cwd` first and still falls back to the 0.1.x shapes.

## License

MIT

---

## 中文说明

**DSH 宿主插件：在长任务失败之前识别它并拆开 —— 为小上下文本地模型而做。**

本地小模型（llama.cpp / Ollama，例如 `maxTokens: 8192` 的 Qwen3-27B IQ2）会在**两类完全不同的**长任务上翻车，
本插件在**宿主侧**把两类都识别出来，并交给模型一套可执行的规程，而不是指望模型自己判断极限。

| | **车道 A：产出型** | **车道 B：流程型** |
|---|---|---|
| 例子 | "写一篇 3000 字的行业报告，分 4 部分" | **"帮我选一只明天大概率会涨的股票"** |
| 提示词 | 通常明确 | **可能极短** |
| 真正瓶颈 | 单次输出预算（`maxTokens`） | **步骤数与上下文**：工具结果塞满窗口、小模型多步跑偏、中间结果丢失 |
| 插件动作 | 建 `tasks/<slug>/parts/NN-*.md` + `MANIFEST.json`；每轮只写一段，最后 `assemble` | 建 `tasks/<slug>/PLAN.md` + `notes/`；**先立计划、每轮一步、结果落盘** |

判定在宿主侧打分（不依赖模型自觉）：车道 A 看字数/分段/分节列表/长文关键词/超长提示词；
车道 B 看**决策研究类动词 + 依赖数据的领域名词**、显式多步措辞、是否需要实时外部信息；
单次查询类（"帮我查一下天气"）会被压到阈值以下。

规程通过 `agent/pre-step` **前置到同一次请求**里（不额外耗一轮），且只处理以人类消息开始的那一步。

安装：

```bash
dsh plugin --profile <你的profile> add dsh-task-splitter
```

装完重启 DSH。配置项同上（`lanes` / `minScore` / `workflowScore` / `maxParts` / `wordsPerPart` / `tasksDir` / `toolPath`）。

**局限**：车道 B 保证的是**过程与诚实性**（计划、证据落盘、来源、不确定性、禁止编造数据），**不保证答案正确**；
本地没有行情/财务数据源时，它就该说"给不出可靠结论"，而不是编数字。检测是启发式的，
`workflowScore` / `minScore` 可调；最坏情况只是多注入一条很短的指令，不会阻塞任何一轮。

**0.1.2 修复**：DSH 0.2.1+ 把会话工作目录挪到了 `session.header.cwd`（实例上不再有 `cwd` / `meta`）。
0.1.1 及更早在这些宿主上会**静默跳过**所有长任务；0.1.2 改为优先读 `header.cwd`，同时保留 0.1.x 的旧形态回退。

MIT 许可。
