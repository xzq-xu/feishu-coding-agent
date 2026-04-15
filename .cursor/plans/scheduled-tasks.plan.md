# 定时任务模块 — 设计方案

## 目标

在 feishu-coding-agent 中新增定时任务能力，通过 macOS cron/launchd 定时触发，调用 cursor-agent / claude / codex 等 Agent 执行代码审查、测试等周期性任务，并将结果自动推送到飞书。

## 为什么集成到 feishu-coding-agent 而不是独立脚本

| 维度 | 集成到项目 | 独立脚本 |
|------|-----------|---------|
| Agent 调用 | 复用 agent-runner.js，4 种 Agent 开箱即用 | 需要自己拼命令行参数 |
| 代码变更分析 | 复用 workspace-diff.js | 需要自己实现 |
| 结果通知 | 直接调飞书 API 发到指定聊天 | 需要额外搭通知管道 |
| 配置管理 | 共享 .env，一处维护 | 需要维护两套 |
| 任务管理 | 后续可通过飞书命令 CRUD | 需要 SSH 上去编辑 |
| 历史追踪 | 复用 session-store 持久化 | 需要自己实现 |

## 架构设计

```
┌─────────────┐     定时触发      ┌──────────────────┐
│  cron/launchd│ ──────────────→ │ src/scheduler.js  │  (独立入口，非飞书长连接进程)
└─────────────┘                  └────────┬─────────┘
                                          │
                           ┌──────────────┼──────────────┐
                           ▼              ▼              ▼
                    agent-runner.js  workspace-diff.js  config.js
                           │
                           ▼
                  cursor-agent / claude / codex / opencode
                           │
                           ▼
                ┌─────────────────────┐
                │ 结果推送到飞书指定聊天  │
                └─────────────────────┘
```

**关键决策：scheduler.js 是独立进程，不是飞书长连接进程的一部分。**

原因：
- cron 每次触发都是冷启动，不依赖飞书 bot 是否在线
- 如果 bot 崩溃，定时任务仍然能跑
- 两个进程互不干扰

## 新增文件

### 1. `data/scheduled-tasks.json` — 任务定义

```json
{
  "tasks": [
    {
      "id": "review-q-skill",
      "enabled": true,
      "schedule": "0 9 * * *",
      "provider": "cursor",
      "mode": "plan",
      "workspace": "/Users/yumeng/q-skill",
      "prompt": "审查最近的代码变更，检查是否有潜在 bug、命名不规范、缺少错误处理等问题。给出具体的改进建议。",
      "reportTo": "oc_xxxxxxxxxxxxxxxx",
      "description": "每天早上 9 点审查 q-skill 代码"
    },
    {
      "id": "test-feishu-agent",
      "enabled": true,
      "schedule": "0 */4 * * *",
      "provider": "cursor",
      "workspace": "/Users/yumeng/Documents/Projects/feishu-coding-agent",
      "prompt": "运行 npm test，如果有失败的测试，分析失败原因并给出修复建议。",
      "reportTo": "oc_xxxxxxxxxxxxxxxx",
      "description": "每 4 小时跑一次 feishu-coding-agent 测试"
    }
  ]
}
```

字段说明：
- `id`: 任务唯一标识
- `enabled`: 是否启用
- `schedule`: cron 表达式（仅用于文档和展示，实际调度由系统 cron 负责）
- `provider`: 使用哪个 Agent（cursor / claude / codex / opencode）
- `mode`: 可选，"plan" 表示只读审查模式（cursor-agent 的 --mode plan）
- `workspace`: 工作目录
- `prompt`: 发给 Agent 的指令
- `reportTo`: 飞书聊天 ID，结果发到这里
- `description`: 人类可读的描述

### 2. `src/scheduler.js` — 定时任务入口

职责：
1. 读取 `scheduled-tasks.json`
2. 根据命令行参数决定执行哪些任务（`--task <id>` 或 `--all-due`）
3. 调用 `agent-runner.js` 执行任务
4. 调用 `workspace-diff.js` 分析代码变更
5. 通过飞书 API 将结果发送到指定聊天
6. 记录执行日志到 `data/scheduler.log`

调用方式：
```bash
# 执行指定任务
node src/scheduler.js --task review-q-skill

# 执行所有已启用任务（配合 cron 使用）
node src/scheduler.js --all
```

### 3. `scripts/install-schedule.sh` — 安装 cron 任务的辅助脚本

职责：
- 读取 `scheduled-tasks.json` 中的任务定义
- 为每个已启用的任务生成 crontab 条目
- 安装到当前用户的 crontab

生成的 crontab 格式：
```cron
# [feishu-coding-agent] 每天早上 9 点审查 q-skill 代码
0 9 * * * cd /Users/yumeng/Documents/Projects/feishu-coding-agent && /usr/local/bin/node src/scheduler.js --task review-q-skill >> data/scheduler.log 2>&1

# [feishu-coding-agent] 每 4 小时跑一次 feishu-coding-agent 测试
0 */4 * * * cd /Users/yumeng/Documents/Projects/feishu-coding-agent && /usr/local/bin/node src/scheduler.js --task test-feishu-agent >> data/scheduler.log 2>&1
```

### 4. 飞书命令扩展（Phase 2，非 MVP）

在 `src/index.js` 中新增命令：
- `/schedule` — 查看所有定时任务
- `/schedule enable <id>` — 启用任务
- `/schedule disable <id>` — 禁用任务
- `/schedule run <id>` — 立即手动执行一次
- `/schedule add` — 交互式创建任务（提供模板）

## scheduler.js 核心流程

```
1. 加载 config.js（读 .env）
2. 读取 scheduled-tasks.json
3. 根据 --task <id> 或 --all 过滤出要执行的任务
4. 对每个任务：
   a. 获取飞书 tenant_access_token
   b. captureWorkspaceSnapshot(before)
   c. runAgentTurn({ provider, prompt, workspace, ... })
   d. captureWorkspaceSnapshot(after)
   e. summarizeWorkspaceChanges(before, after)
   f. 构造结果卡片，POST 到 reportTo 指定的飞书聊天
   g. 记录执行日志（成功/失败、耗时、Agent 输出摘要）
5. 退出
```

## 飞书推送格式

定时任务的结果卡片与现有的 Agent 结果卡片风格保持一致，但 header 标注为定时任务：

```
╔══════════════════════════════════════╗
║  ⏰ 定时任务结果 · review-q-skill    ║
╠══════════════════════════════════════╣
║  Agent: Cursor Agent                 ║
║  工作目录: /Users/yumeng/q-skill     ║
║  执行耗时: 2 分 34 秒                ║
║  触发方式: 定时 (0 9 * * *)          ║
╠══════════════════════════════════════╣
║                                      ║
║  （Agent 审查结果正文）               ║
║                                      ║
╠══════════════════════════════════════╣
║  代码改动摘要: 无改动（只读审查）      ║
╚══════════════════════════════════════╝
```

## 实施步骤

### Phase 1: MVP（核心能力）
- [ ] 定义 `data/scheduled-tasks.json` 格式并创建示例
- [ ] 实现 `src/scheduler.js`，复用 agent-runner + workspace-diff
- [ ] 实现飞书 API 直接推送（不经过长连接，直接用 tenant_access_token + REST API）
- [ ] 编写 `scripts/install-schedule.sh` 安装 cron
- [ ] 测试：手动 `node src/scheduler.js --task <id>` 验证端到端流程

### Phase 2: 飞书管理（可选）
- [ ] 在 src/index.js 里新增 `/schedule` 系列命令
- [ ] 支持从飞书里启用/禁用/手动触发定时任务
- [ ] `/schedule run <id>` 手动触发后，结果也回复到当前聊天

### Phase 3: 增强（可选）
- [ ] 支持任务执行结果的历史记录查询
- [ ] 支持任务失败后自动重试
- [ ] 支持任务超时自动终止
- [ ] 支持多任务并行执行

## 需要注意的问题

1. **环境变量**：cron 执行时的 PATH 和用户登录 shell 不同，`scripts/install-schedule.sh` 需要在 crontab 里显式设定 PATH，确保能找到 node、cursor-agent 等二进制
2. **cursor-agent 登录态**：`cursor-agent -p` 需要已登录的状态，cron 环境下需确认 token 文件可访问
3. **并发保护**：如果上一轮定时任务还没跑完，下一轮又触发了，需要加锁（可复用现有的 process-lock.js 思路）
4. **日志轮转**：`data/scheduler.log` 需要考虑大小限制或轮转
5. **mode: plan 的意义**：代码审查类任务应该用 `--mode plan`（只读），避免 Agent 自作主张修改代码；测试类任务则需要正常模式
