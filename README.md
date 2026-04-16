# 飞书 Coding Agent

一个最小可运行的实验项目：

- 飞书机器人通过长连接收消息
- 将文本消息转给本机 `codex`
- 把 Codex 的最终响应回发到飞书
- 按聊天维度保存多个会话，并展示最近活跃会话
- 支持把同一个 session 从私聊挂接到群聊，或从一个群挂接到另一个群继续

## MVP 能力

- 主面板只接受命令；私聊主面板可用显式路由，群聊主面板需 `@机器人 S1: ...`；线程里直接回复即可继续会话
- Codex 完成后自动把结果发回飞书
- 同一聊天里可保留多个会话
- 每个会话可绑定自己的工作目录
- 每个会话都会显示状态：空闲 / 运行中 / 已完成 / 失败
- 每个会话都可以在创建时指定 Agent：Codex / Claude Code / Cursor Agent / OpenCode
- 每个会话都会暴露稳定的“转移 ID”
- 每次结果会直接以一张卡片发送，卡片里同时展示结果、会话信息和可用命令
- 每个新会话都会生成一条主消息，后续结果会回复到这条消息下面，便于按话题管理
- 每轮完成后会附带代码改动摘要，便于人工审查
- 如果本轮发生了分支切换或提交变化，也会直接显示在结果卡片里
- 私聊里可用 `S1: 继续处理` 这种前缀把消息发给指定会话
- `/new` 创建新会话
- `/new cursor` 创建新会话并直接指定 Agent
- `/new /path/to/project` 创建新会话并直接指定工作目录
- `/new cursor /path/to/project` 创建新会话并同时指定 Agent 和工作目录
- `/new /path/to/project 你的第一条指令` 创建新会话、指定目录并立即开始第一轮
- `/new cursor /path/to/project 你的第一条指令` 创建新会话、指定 Agent、指定目录并立即开始第一轮
- `/agent` 查看当前活跃会话使用的 Agent
- `/cwd` 查看当前活跃会话的工作目录
- `/cwd /path/to/project` 修改当前活跃会话的工作目录
- `/cwd S1 /path/to/project` 修改指定会话的工作目录
- `/stop` 停止当前正在运行的会话
- `/stop S1` 停止指定会话
- `/delete` 删除当前活跃会话
- `/delete S1` 删除指定会话，并自动整理剩余编号
- `/show S1` 查看某个会话最近 10 条消息
- `/diff S1` 查看某个会话最近一轮代码改动摘要
- `/attach <转移ID>` 把另一个聊天里的 session 挂接到当前聊天继续
- `/fork S1` 在主面板里 fork 一个新会话，复制独立工作区，继承原会话最近上下文并自动创建新 topic
- `/sessions` 查看最近会话；私聊主面板里显示全局
- `/status` 查看当前状态；私聊主面板里显示全局
- `/clean` 清空会话；私聊里清空全部，群聊里清空当前群聊
- `/cron` 查看定时任务列表
- `/cron add <调度> <目录> <描述> [--provider X] [--mode plan]` 创建定时任务
- `/cron run <id>` 立即手动执行一个定时任务
- `/cron enable <id>` 启用定时任务
- `/cron disable <id>` 禁用定时任务
- `/cron delete <id>` 删除定时任务
- `/help` 查看帮助
- 任何以 `/` 开头但不属于已知命令的输入，都会被拦截，不会发送给 Codex

## 不做的事

- 不做卡片按钮回调
- 不做多会话并行管理 UI
- 不做任务审批流
- 不做复杂权限系统

## 前置要求

1. 本机已安装并可直接运行 `codex`
2. 飞书开放平台应用已创建
3. 应用启用了机器人能力和事件订阅
4. 应用已开通 `im.message.receive_v1`
5. 机器人具备发消息权限

建议至少勾上这几项：

- `im:message`
- `im:message.group_at_msg`
- `im:message:readonly`

如果你要在私聊中使用，还需要对应的私聊消息权限。

## 环境变量

复制 `.env.example` 为 `.env`，至少填写：

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
AGENT_PROVIDER=codex
CODEX_WORKSPACE=/Users/xzq/Documents/Playground
CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex
CLAUDE_BIN=claude
CLAUDE_PERMISSION_MODE=bypassPermissions
CLAUDE_SETTING_SOURCES=
CURSOR_AGENT_BIN=cursor-agent
OPENCODE_BIN=opencode
CODEX_SANDBOX=workspace-write
CODEX_AUTO_APPROVAL=true
CODEX_SKIP_GIT_REPO_CHECK=true
DEFAULT_REPORT_CHAT_ID=oc_xxx
```

说明：

- 机器人会在启动时自动通过飞书 OpenAPI 拉取自己的 bot 信息，用于精确识别群聊里的 `@机器人`
- `AGENT_PROVIDER` 用来设置默认 Agent，可选 `codex`、`claude`、`cursor`、`opencode`
- `CODEX_WORKSPACE` 是 Codex 真正工作的目录
- `CODEX_WORKSPACE` 现在只作为默认目录，新会话会默认继承它；后续可以在飞书里按会话改掉
- `CLAUDE_SETTING_SOURCES` 可选；如果你的 `~/.claude/settings.json` 里配了代理或自定义网关，想临时忽略用户级配置，可设成 `project,local`
- `CODEX_AUTO_APPROVAL=true` 会让 Codex 以无人值守方式执行，适合实验环境，风险更高
- `CODEX_SKIP_GIT_REPO_CHECK=true` 允许你把工作目录指到非 git 仓库，适合 MVP 实验
- 当 `CODEX_AUTO_APPROVAL=true` 时，Codex 会跳过审批并绕过 sandbox；如果你想保留 `workspace-write` 隔离，请把它设为 `false`
- `DEFAULT_REPORT_CHAT_ID` 是定时任务结果推送的默认聊天 ID；任务配置里的 `reportTo` 为空时会使用这个值

## 启动

```bash
npm install
npm start
```

启动后，机器人会通过飞书长连接等待事件，不需要公网 webhook。

## 交互方式

私聊主面板只接受命令或显式路由，不再默认把普通正文发给某个 session。
群聊主面板则只接受 `@机器人 + 命令` 或 `@机器人 S1: ...`。

私聊里推荐这样新建会话：

```text
/new codex /Users/xzq/project-a 帮我检查一下当前仓库里有哪些 TODO
```

或者继续一个本地会话：

```text
S1: 把 README 也补上
```

群聊主面板里推荐这样用：

```text
@机器人 /new codex /Users/xzq/project-a 帮我检查一下当前仓库里有哪些 TODO
```

如果你想在群聊主面板里显式续接某个会话：

```text
@机器人 S1: 继续这个会话
```

机器人会先回：

```text
已收到，正在为你启动新的会话 S1。
```

新会话建立后，机器人会为这个 session 发一条主消息。之后这个 session 的执行结果会持续回复到这条主消息下面。
你直接回复这条线程里的任意一条消息，就会自动续接对应的 session。

待 Codex 执行完成后，会直接发送一张结果卡片，里面包含：

- Codex 最终回复
- 当前状态
- 转移 ID
- 当前会话 ID
- 当前工作目录
- 会话总览提示
- 本轮代码改动摘要
- 可直接复制使用的文本命令提示

其中空闲会话会明确标成 `空闲`，方便你快速挑一个继续推进，不让它闲着。
如果你想把一个 session 从私聊转到群聊，或从一个群转到另一个群，可以直接使用卡片里的 `转移 ID`：

```text
/attach 456c4598-c50c-4bd4-875b-584ef20cfbb5
```

attach 成功后，当前聊天里会生成一个新的本地别名，之后继续用这个本地别名即可：

```text
S1: 继续这个会话
```

如果你是在群聊主面板里继续，请记得带上 `@机器人`：

```text
@机器人 S1: 继续这个会话
```

如果你想从某个已有会话分叉出一个新的会话，但保留最近若干轮上下文：

```text
/fork S1
```

这个命令只能在主面板使用，不能在已有 topic 内使用。执行后会：

- 新建一个新的本地会话
- 继承原会话的 Agent
- 在原工作目录的同级目录下复制一个新的工作区给 fork 会话使用
- 复制原会话最近若干轮上下文，作为新会话首轮的继承上下文
- 自动创建一个新的 topic 入口
- 如果后续删除这个 fork 出来的 session，这个复制出来的工作区不会自动删除

已创建的会话不支持中途切换 Agent。
这是为了避免底层 Agent 自己的会话上下文丢失或串线。
如果你想换 Agent，请直接新建一个会话：

```text
/new claude /Users/xzq/project-a 你的第一条指令
```

如果你想新开一个话题：

```text
/new
```

然后直接发新消息即可。

如果你想新建会话时直接指定 Agent：

```text
/new cursor
```

如果你想新建会话时直接指定目录：

```text
/new /Users/xzq/project-a
```

如果你想新建会话时同时指定 Agent 和目录：

```text
/new cursor /Users/xzq/project-a
```

如果你想新建会话、指定目录并立刻开始：

```text
/new /Users/xzq/project-a 帮我分析这个仓库的测试失败原因
```

如果你想新建会话、指定 Agent、指定目录并立刻开始：

```text
/new cursor /Users/xzq/project-a 帮我分析这个仓库的测试失败原因
```

如果你想切换当前会话的工作目录：

```text
/cwd /Users/xzq/project-a
```

如果你想切换指定会话的工作目录：

```text
/cwd S1 /Users/xzq/project-b
```

如果你想查看当前会话工作目录：

```text
/cwd
```

如果你想手动停止一个正在运行的会话：

```text
/stop
```

如果你想停止指定会话：

```text
/stop S1
```

如果你想查看某个会话最近 10 条消息：

```text
/show S1
```

如果你想查看某个会话最近一轮改了什么代码：

```text
/diff S1
```

如果你想把另一个聊天里的 session 接到当前聊天继续：

```text
/attach <转移ID>
```

如果你想删除当前活跃会话：

```text
/delete
```

如果你想删除某个指定会话：

```text
/delete S1
```

删除后，剩余会话会自动重新编号，例如原来的 `S2` 会补成新的 `S1`。

如果你想清空会话：

```text
/clean
```

- 私聊里执行 `/clean`：清空全部聊天下的所有会话
- 群聊里执行 `/clean`：清空当前群聊下的所有会话

如果你想明确把消息发给某个会话：

```text
S1: 把 README 也补上
```

如果你在私聊里想看全局总览：

```text
/sessions
/status
```

这两个命令在私聊主面板里会显示所有聊天下的会话，并带上：

- 聊天名/群名
- 工作目录
- 转移 ID

## 定时任务

支持通过 cron 定时触发 Agent 执行代码审查、跑测试等周期性任务，结果自动推送到飞书。

### 配置

```bash
# 1. 从示例创建任务配置
cp data/scheduled-tasks.example.json data/scheduled-tasks.json

# 2. 编辑任务（可选，不填 reportTo 会使用 .env 里的 DEFAULT_REPORT_CHAT_ID）
vi data/scheduled-tasks.json
```

任务定义示例：

```json
{
  "tasks": [
    {
      "id": "C1",
      "enabled": true,
      "schedule": "0 9 * * *",
      "provider": "cursor",
      "mode": "plan",
      "workspace": "/Users/yumeng/q-skill",
      "prompt": "审查最近的代码变更，给出改进建议。",
      "reportTo": "",
    }
  ]
}
```

字段说明：

| 字段 | 必填 | 说明 | 默认值 |
|------|------|------|--------|
| `schedule` | **是** | 执行频率（通过 `/cron add` 创建时从简写自动生成） | — |
| `workspace` | **是** | Agent 执行的项目目录绝对路径 | — |
| `prompt` | **是** | 发给 Agent 的指令内容 | — |
| `provider` | 否 | Agent 类型：`cursor` / `codex` / `claude` / `opencode` | 跟随 `AGENT_PROVIDER` 环境变量 |
| `mode` | 否 | `"plan"` 表示只读审查模式，Agent 只分析不改代码 | 不设置 = 正常模式 |
| `id` | 否 | 任务唯一标识，格式为 C1、C2、C3… | `/cron add` 时自动递增生成 |
| `enabled` | 否 | 是否启用 | `true` |
| `reportTo` | 否 | 飞书聊天 ID，结果推送目标 | `/cron add` 时自动填为当前聊天；留空则使用 `DEFAULT_REPORT_CHAT_ID` |

### 手动执行

```bash
# 执行指定任务
node src/scheduler.js --task C1

# 模拟执行（不实际调用 Agent）
node src/scheduler.js --dry-run --task C1

# 执行所有已启用任务
node src/scheduler.js --all

# 查看任务列表
node src/scheduler.js --list
```

### 安装到系统 cron

```bash
# 安装
npm run schedule:install

# 查看当前 crontab
crontab -l

# 卸载
npm run schedule:uninstall
```

### 飞书内管理

在飞书聊天中可直接管理定时任务：

- `/cron` — 查看所有任务
- `/cron add <调度> <目录> <描述> [--provider X] [--mode plan]` — 创建任务
- `/cron run <id>` — 立即手动执行
- `/cron enable <id>` — 启用任务
- `/cron disable <id>` — 禁用任务
- `/cron delete <id>` — 删除任务

创建任务时，只需提供**调度**、**工作目录**、**任务描述**三个必填参数。`id`、`enabled`、`reportTo` 等字段自动填充（`reportTo` 默认为当前聊天）。可通过 `--provider` 和 `--mode` 覆盖默认值。

调度格式：

| 格式 | 含义 | 说明 |
|------|------|------|
| `hourly` | 每小时 | 整点执行 |
| `hourly N` | 每 N 小时 | 如 `hourly 4` = 0:00, 4:00, 8:00… |
| `daily` | 每天 9:00 | 默认早上 9 点 |
| `daily H` | 每天 H 点 | 如 `daily 14` = 每天 14:00 |
| `daily H:MM` | 每天 H:MM | 如 `daily 14:30` |
| `weekly` | 每周一 9:00 | 默认周一早上 9 点 |
| `weekly D` | 每周 D 的 9:00 | D: 0=周日, 1=周一, …6=周六 |
| `weekly D H` | 每周 D 的 H 点 | 如 `weekly 1 10` = 每周一 10:00 |

示例：

```text
/cron add daily /Users/yumeng/q-skill 审查最近的代码变更，给出改进建议
/cron add hourly 4 /Users/yumeng/project 跑一次测试，分析失败原因
/cron add daily 14 /Users/yumeng/q-skill 审查代码 --mode plan
/cron add weekly 1 9 /Users/yumeng/project 每周一审查代码 --provider codex
```

## 目录

```text
src/config.js          环境变量读取
src/agent-runner.js    Agent 执行器抽象，支持 Codex / Claude / Cursor / OpenCode
src/session-store.js   聊天到多个 Agent 会话的持久化映射
src/scheduler.js       定时任务调度入口
src/index.js           飞书长连接入口
scripts/install-schedule.sh  cron 安装/卸载辅助脚本
data/sessions.json     运行时自动生成
data/scheduled-tasks.json    定时任务定义（需手动创建）
```

## 已知限制

- 当前最近会话摘要默认展示前 5 个
- `/show S1` 当前只展示最近 10 条文本消息
- `/diff S1` 会优先比较 git 提交点前后差异，再回退到工作区前后快照；非 git 目录下无法提供代码 diff 摘要
- 删除会话后，剩余会话会自动重排编号
- `S1/S2` 这类 alias 始终只在当前聊天内有效；跨聊天续接必须使用 `/attach <转移ID>`
- 相对路径会相对默认目录 `CODEX_WORKSPACE` 解析，建议移动端直接发绝对路径
- 如果目录路径里有空格，建议在 `/new` 或 `/cwd` 里用引号包起来
- 当前卡片是纯展示卡片，不带按钮；所有操作都通过文本命令完成
- 当前只有“任务结果”合并成单张卡片；部分命令响应和错误提示仍然使用普通文本
- 只发送 Codex 最终回复，不做流式中间输出
- 如果 Codex 运行很久，飞书里只会先看到“处理中”的提示，再等最终结果
- 没有做消息签名 webhook 逻辑，因为这个项目使用的是飞书长连接模式
