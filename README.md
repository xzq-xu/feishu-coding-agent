# 飞书 Coding Agent

一个最小可运行的实验项目：

- 飞书机器人通过长连接收消息
- 将文本消息转给本机 `codex`
- 把 Codex 的最终响应回发到飞书
- 按聊天维度保存多个会话，并展示最近活跃会话

## MVP 能力

- 直接发送文本给当前活跃会话
- Codex 完成后自动把结果发回飞书
- 同一聊天里可保留多个会话
- 每个会话可绑定自己的工作目录
- 每个会话都会显示状态：空闲 / 运行中 / 已完成 / 失败
- 每个会话都可以在创建时指定 Agent：Codex / Claude Code / Cursor Agent / OpenCode
- 每次结果里自动附带最近活跃的几个会话摘要
- 每次结果会直接以一张卡片发送，卡片里同时展示结果、会话信息和可用命令
- 每个新会话都会生成一条主消息，后续结果会回复到这条消息下面，便于按话题管理
- 每轮完成后会附带代码改动摘要，便于人工审查
- 如果本轮发生了分支切换或提交变化，也会直接显示在结果卡片里
- `S1: 继续处理` 这种前缀可把消息发给指定会话
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
- `/sessions` 查看最近活跃会话
- `/status` 查看当前聊天状态
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
FEISHU_BOT_OPEN_ID=ou_xxx
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
```

说明：

- `FEISHU_BOT_OPEN_ID` 用来忽略机器人自己发出的消息，避免回环
- `AGENT_PROVIDER` 用来设置默认 Agent，可选 `codex`、`claude`、`cursor`、`opencode`
- `CODEX_WORKSPACE` 是 Codex 真正工作的目录
- `CODEX_WORKSPACE` 现在只作为默认目录，新会话会默认继承它；后续可以在飞书里按会话改掉
- `CLAUDE_SETTING_SOURCES` 可选；如果你的 `~/.claude/settings.json` 里配了代理或自定义网关，想临时忽略用户级配置，可设成 `project,local`
- `CODEX_AUTO_APPROVAL=true` 会让 Codex 以无人值守方式执行，适合实验环境，风险更高
- `CODEX_SKIP_GIT_REPO_CHECK=true` 允许你把工作目录指到非 git 仓库，适合 MVP 实验
- 当 `CODEX_AUTO_APPROVAL=true` 时，Codex 会跳过审批并绕过 sandbox；如果你想保留 `workspace-write` 隔离，请把它设为 `false`

## 启动

```bash
npm install
npm start
```

启动后，机器人会通过飞书长连接等待事件，不需要公网 webhook。

## 交互方式

直接给机器人发消息：

```text
帮我检查一下当前仓库里有哪些 TODO
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
- 当前会话 ID
- 当前工作目录
- 最近活跃会话
- 本轮代码改动摘要
- 可直接复制使用的文本命令提示

其中空闲会话会明确标成 `空闲`，方便你快速挑一个继续推进，不让它闲着。

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

如果你想删除当前活跃会话：

```text
/delete
```

如果你想删除某个指定会话：

```text
/delete S1
```

删除后，剩余会话会自动重新编号，例如原来的 `S2` 会补成新的 `S1`。

如果你想明确把消息发给某个会话：

```text
S1: 把 README 也补上
```

## 目录

```text
src/config.js          环境变量读取
src/agent-runner.js    Agent 执行器抽象，支持 Codex / Claude / Cursor / OpenCode
src/session-store.js   聊天到多个 Agent 会话的持久化映射
src/index.js           飞书长连接入口
data/sessions.json     运行时自动生成
```

## 已知限制

- 当前最近会话摘要默认展示前 5 个
- `/show S1` 当前只展示最近 10 条文本消息
- `/diff S1` 会优先比较 git 提交点前后差异，再回退到工作区前后快照；非 git 目录下无法提供代码 diff 摘要
- 删除会话后，剩余会话会自动重排编号
- 相对路径会相对默认目录 `CODEX_WORKSPACE` 解析，建议移动端直接发绝对路径
- 如果目录路径里有空格，建议在 `/new` 或 `/cwd` 里用引号包起来
- 当前卡片是纯展示卡片，不带按钮；所有操作都通过文本命令完成
- 当前只有“任务结果”合并成单张卡片；部分命令响应和错误提示仍然使用普通文本
- 只发送 Codex 最终回复，不做流式中间输出
- 如果 Codex 运行很久，飞书里只会先看到“处理中”的提示，再等最终结果
- 没有做消息签名 webhook 逻辑，因为这个项目使用的是飞书长连接模式
