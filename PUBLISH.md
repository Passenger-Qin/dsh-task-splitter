# 发布清单：dsh-task-splitter

> 结论先说：**这个插件值得上架**（生态无同类），但**发布动作必须用你自己的账号**——
> 本机没有 npm 凭据（`npm whoami` → `ENEEDAUTH`），没有 GitHub CLI，且本机 registry 是
> `registry.npmmirror.com`（镜像站不能发布）。

## 一、已经准备好的（我做完的部分）

| 项 | 状态 |
|---|---|
| 代码可移植 | ✅ 已把 `task-parts.mjs` **打进包内**（`bin/task-parts.mjs`），规程里的路径改为**包内相对路径**（不再依赖作者本机的 `D:\dsh\.local-llm`） |
| package.json | ✅ 名称 `dsh-task-splitter`（npm 上**未被占用**）、`keywords: dsh/dsh-plugin/deepseek-harness/...`、`dsh.bundle.patch`、`files`、`bin`、`engines`、`peerDependencies`（`^0.1.1-rc.2 \|\| ^0.2.0-rc.1` 并集） |
| LICENSE | ✅ MIT（**记得把 `<YOUR NAME HERE>` 换成你的名字**） |
| README | ✅ 中英双语，含两类长任务对照、判定示例、配置、局限说明 |
| 测试 | ✅ 27 项离线仿真测试（`test-sim.mjs`，不打进包） |
| 打包验证 | ✅ `npm pack` → 13.4 KB，内容正确；解包后自带 CLI 可独立运行 |

## 二、你需要执行的三步

```bash
# 1. 登录官方源（本机 registry 是镜像，必须显式指定）
npm login --registry=https://registry.npmjs.org

# 2. 进包目录，先干跑看一眼内容
cd D:\dsh\.local-llm\plugins\dsh-task-splitter
npm pack --dry-run

# 3. 发布
npm publish --registry=https://registry.npmjs.org --access public
```

发布后任何人可以：

```bash
dsh plugin --profile <profile> add dsh-task-splitter
```

## 三、想被插件市场索引，再补两件事

1. **建一个 GitHub 仓库**（例如 `dsh-task-splitter`），把源码推上去，并：
   - 给仓库加 topic：**`dsh-plugin`**（`find_dsh_plugins` 会搜这个 topic）；
   - 在 package.json 里补 `repository` 字段（发布新版本时生效）；
   - 打 tag（如 `v0.1.0`）。多家目录以 GitHub 仓库 + tag 作为安装源（`github:user/repo#v0.1.0`）。
2. **提交到社区目录**：
   - `awesome-dsh-plugin`：往它的清单仓库提 PR 增加一条（描述 + 安装命令）；
   - `dsh.so` / `dsh.works` / `dsh-plugin-radar`：会**自动抓取 npm 与 GitHub topic**，
     所以「npm 发布 + 仓库带 topic」之后通常无需额外提交，等索引即可；
   - 建议同时提供一条 `github:` 安装方式，方便用户锁版本。

## 四、另一个插件（dsh-auto-continue）的建议：暂不上架

生态里已经有 3 个同类，其中两个**正是**"输出到上限自动续写、面向小输出模型"：

| 已有插件 | 说明 |
|---|---|
| `HsiangNianian/dsh-auto-continue` ★143（npm `dsh-client-auto-continue`） | 网络/超时/崩溃后自动续跑，错误分类 + 退避 |
| `qwert702/dsh-continue-on-limit` | **输出上限自动继续**、双源截断检测、防死循环 |
| `zhou1736948757-cpu/dsh-auto-continue` | **token 上限截断自动续写**，面向 Ollama 小输出场景 |

而且 **npm 上 `dsh-auto-continue` 这个名字已被占用（0.4.7）**，要发就得改名（例如 `dsh-continue-chain`）。

建议：**作为本插件（task-splitter）的可选搭档在 README 里提一句**即可；如果你仍想独立上架，
先想清楚差异化点（我们的实现是宿主侧 `turn/end` 判定 + 每链上限 + provider 过滤 + 与拆分插件协同），
然后改名发布。要做的话告诉我。

## 五、本机部署与发布版保持同步

本机 profile 里那份是"复制安装"（不是 npm 安装），改代码后需要重新复制：

```powershell
Copy-Item D:\dsh\.local-llm\plugins\dsh-task-splitter\lib\index.js  C:\Users\pc\.dsh\profiles\desktop\node_modules\dsh-task-splitter\lib\ -Force
Copy-Item D:\dsh\.local-llm\plugins\dsh-task-splitter\bin -Recurse C:\Users\pc\.dsh\profiles\desktop\node_modules\dsh-task-splitter\ -Force
```

（也可以用 `npm pack` 出的 `.tgz` 走 `dsh plugin --profile desktop add file:...tgz` 正式安装，
这样以后 `dsh plugin` 的依赖管理不会把它当"未登记目录"清掉。）
