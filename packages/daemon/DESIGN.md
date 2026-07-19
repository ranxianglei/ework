# ework-daemon — Issue-Driven AI Development System

> 人开 Issue，AI 干活，Issue 即通信通道。

## 系统总览

```
                    ┌─────────────┐
                    │  Gitea UI   │  用户创建 Issue / 发评论
                    └──────┬──────┘
                           │ Webhook (POST)
                           ▼
                    ┌─────────────┐
                    │  server.ts  │  多端点路由 + REST API
                    │  /webhook/* │
                    └──────┬──────┘
                           │ TrackerEvent
                           ▼
┌──────────────────────────────────────────────────┐
│                  opencode.ts                      │
│                   Engine                          │
│                                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ 事件分发  │ │ 抢占调度器│ │ IssueObserver   │ │
│  │Dispatch  │ │Scheduler │ │ (全局轮询 5min)  │ │
│  └────┬─────┘ └────┬─────┘ └──────────────────┘ │
│       │            │                             │
│  ┌────▼────────────▼─────┐                       │
│  │    Process Manager    │                       │
│  │  spawn / kill / read  │                       │
│  └───────────────────────┘                       │
└────────────────┬─────────────────────────────────┘
                 │ IssueTracker 接口
                 ▼
        ┌────────────────┐
        │ TrackerRegistry│  Map<string, IssueTracker>
        │  ┌───────────┐ │
        │  │   Gitea   │ │  ← 已实现
        │  │  Tracker   │ │
        │  └───────────┘ │
        │  ┌───────────┐ │
        │  │   Plane   │ │  ← 待实现
        │  │  Tracker   │ │
        │  └───────────┘ │
        └────────────────┘
                 │
                 ▼
        ┌────────────────┐
        │   op.ts Store  │  SQLite 三表持久化
        │  issues        │
        │  op_sessions   │
        │  messages      │
        └────────────────┘
```

## 模块职责

| 模块 | 文件 | 行数 | 职责 |
|------|------|------|------|
| **配置** | config.ts | 122L | Zod schema，test/production 双模式，环境变量读取 |
| **Tracker 类型** | trackers/types.ts | 155L | 三实体接口、IssueTracker 抽象、key 格式 |
| **Gitea 适配** | trackers/gitea-tracker.ts | 172L | IssueTracker 的 Gitea 实现 |
| **HTTP 客户端** | gitea.ts | 130L | Gitea REST API 封装，bot/admin 双 token |
| **持久层** | op.ts | 490L | Store 类，SQLite 三表 CRUD，旧表迁移 |
| **引擎** | opencode.ts | 1101L | 核心调度：事件分发、抢占调度、进程管理、Observer、恢复 |
| **服务端** | server.ts | 153L | Webhook 路由 + REST API (12 端点) |
| **入口** | index.ts | 47L | 组装：Config→GiteaClient→GiteaTracker→Store→Engine→Server |
| **CLI** | cli.ts | 218L | 命令行工具，10 个子命令 |

## 三实体模型

### 实体定义

```
┌─────────────────────────────────────────────────────┐
│                      Issue                           │
│  lifecycle: created → active → closed (可循环 reopen) │
│  拥有: 0..N OpSession                                │
│  唯一键: (tracker_type, tracker_scope_key,            │
│           tracker_issue_id)                          │
└──────────────────────┬──────────────────────────────┘
                       │
            ┌──────────▼──────────┐
            │     OpSession       │
            │ (永不销毁)           │
            │                     │
            │ name: "ework-daemon"  │
            │ state: idle/running │
            │ 持久化运行时状态      │
            │ (用于崩溃恢复)       │
            │ 唯一键: (issue_id,  │
            │          name)      │
            └──────────┬──────────┘
                       │
            ┌──────────▼──────────┐
            │      Message        │
            │ (投递给 opencode    │
            │  的 prompt)         │
            │                     │
            │ status:             │
            │  pending → running  │
            │  → done/failed/     │
            │    interrupted      │
            └─────────────────────┘
```

### 生命周期

```
Issue:
  created ──→ active ──→ closed ──→ active (reopen)
                 ▲                       │
                 └───────────────────────┘

OpSession:
  created ──→ idle ←→ running    (永不销毁)
                  │
                  └─→ (issue closed 时 session 仍存在, 只是暂停)

Message:
  pending ──→ running ──→ done
                   │      └──→ failed (可 retry)
                   │      └──→ interrupted (被抢占或 issue 关闭)
                   └──→ pending (恢复时回退)
```

### Runtime Key 格式

```
trackerType:scopeKey#issueId@sessionName

示例:
  gitea:owner/repo#123@ework-daemon
  plane:test-ws/proj-uuid#wi-456@ework-daemon
```

Key 仅存在于内存 Map/Set 中，**不存入 DB**。

## DB Schema

```sql
CREATE TABLE issues (
  id TEXT PRIMARY KEY,                              -- UUID
  tracker_type TEXT NOT NULL,                        -- "gitea" | "plane" | ...
  tracker_scope_key TEXT NOT NULL,                   -- "owner/repo" | "ws/proj"
  tracker_scope TEXT NOT NULL,                       -- JSON: {"owner":"<owner>","repo":"<repo>"}
  tracker_issue_id TEXT NOT NULL,                    -- "123" | "wi-456"
  state TEXT NOT NULL DEFAULT 'created',             -- created/active/closed
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tracker_type, tracker_scope_key, tracker_issue_id)
);

CREATE TABLE op_sessions (
  id TEXT PRIMARY KEY,                               -- UUID
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                                -- "ework-daemon" | custom
  state TEXT NOT NULL DEFAULT 'idle',                -- idle/running
  opencode_session_id TEXT,                          -- opencode --session 参数
  opencode_pid INTEGER,                              -- 当前进程 PID (用于恢复)
  workdir TEXT,                                      -- 工作目录
  created_at TEXT NOT NULL,
  -- 持久化运行时状态 (崩溃恢复用)
  started_at INTEGER,
  progress_comment_id TEXT,
  reaction_comment_id TEXT,
  current_prompt TEXT,
  completion_check_rounds INTEGER,
  UNIQUE(issue_id, name)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,                               -- UUID
  session_id TEXT NOT NULL REFERENCES op_sessions(id) ON DELETE CASCADE,
  content TEXT NOT NULL,                             -- prompt 内容
  source_comment_id TEXT,                            -- 来源评论 ID (去重用)
  reaction_comment_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',            -- pending/running/done/failed/interrupted
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## IssueTracker 接口

```typescript
interface IssueTracker {
  readonly type: string;  // "gitea" | "plane" | ...

  // Scope 管理
  formatScopeKey(scope: Record<string, string>): string;

  // Issue 交互
  createComment(ref: TrackerRef, body: string): Promise<{ id: string }>;
  editComment(ref: TrackerRef, commentId: string, body: string): Promise<void>;
  listComments(ref: TrackerRef): Promise<TrackerComment[]>;
  closeIssue(ref: TrackerRef): Promise<void>;
  setReaction(ref: TrackerRef, commentId: string, content: string, remove?: boolean): Promise<void>;

  // Prompt 注入
  getTrackerInstructions(ref: TrackerRef): TrackerInstructions;
  // 返回: { clone, readIssue, postReply, closeIssue? }

  // Webhook 处理
  verifyWebhookSignature(rawBody: string, headers: Record<string, string | null>): boolean;
  parseWebhookEvent(rawBody: string): TrackerEvent | null;

  // 身份识别
  isBotUser(userIdentifier: string): boolean;
}
```

## 引擎层 (opencode.ts)

Engine 是系统核心，管理 opencode 子进程的完整生命周期。

### 内部架构

```
Engine
  │
  ├── 事件分发 (Dispatch)
  │   handleEvent() → handleOpened / handleCommented / handleClosed
  │
  ├── 抢占式调度器 (Scheduler)
  │   enqueueOrRun() → executeMessage() / preemptSession()
  │
  ├── 进程管理器 (Process Manager)
  │   execProcess() → spawn → read stdout → exit → finishRun()
  │
  ├── 完成检查 (Completion Check)
  │   checkCompletion() → LLM 判断 / 启发式
  │   自动续跑 (最多 3 轮)
  │
  ├── IssueObserver (全局轮询)
  │   单 timer 5min 间隔，遍历所有 active issue
  │   stuck 检测 / 进度报告 / 孤儿修复
  │
  └── 恢复系统 (Recovery)
      启动时：杀孤儿进程 → 恢复 runtime state → 重跑 stuck messages
```

### Runtime State（内存 Map）

12 个 `Map<string, T>` 全部以 session key 为索引：
`processes`, `running`, `stopping`, `currentMessage`, `lastOutputAt`, `startedAt`, `queuedAt`, `progressCommentId`, `commentCountBefore`, `stuckCounts`, `completionCheckRounds`, `currentPrompt`

### 事件分发

```
TrackerEvent 到达
  │
  ├── issue_opened
  │   findOrCreateIssue → state=active → startObserver
  │   创建默认 session (name=bot.username)
  │   ack: "🔄 ework-daemon picked up this issue."
  │   buildInitialPrompt → enqueueOrRun
  │
  ├── comment_created
  │   忽略 bot 自己的评论 (防递归) + 去重
  │   未 track → 自动 track
  │   有 @name → 定向投递 (找/创建 session)
  │   无 @ → 广播所有 session
  │   ack → buildForwardPrompt → enqueueOrRun
  │
  └── issue_closed
      state → closed → 杀进程 → msg=interrupted → session=idle
```

### 抢占式调度

用户消息可以打断运行中的 opencode 进程：
1. 旧消息 → `interrupted`
2. 杀旧进程，旧 execProcess 检测到进程被替换后跳过 finishRun
3. 新消息 executeMessage，复用 opencode session ID（对话连续性）

### 完成检查

进程退出后：
- 检查 bot 评论数是否增加
- 有 LLM API 配置 → 调用 LLM 判断 DONE/CONTINUE
- 否则启发式（评论含 CONTINUE/WIP/进行中 → CONTINUE）
- CONTINUE 且 rounds < 3 → 自动续跑

### IssueObserver

单全局 timer，5 分钟间隔：
- Process 存活 + lastOutput > 30min → stuck（警告/kill）
- Process 不存在 → 标记 failed，重新调度
- Session running 但无 process → 修正为 idle
- 运行中的 session → 创建/编辑进度评论

### 恢复系统

启动时：
1. 杀孤儿进程（opencodePid 存在且存活 → SIGKILL）
2. 从 DB 恢复 runtime state 到内存 Map
3. running messages → 回退为 pending → 按序重跑

## 消息格式

### Prompt 模板

三种 prompt，均通过 `tracker.getTrackerInstructions(ref)` 注入 tracker 命令：

- **Initial Prompt**：issue_opened 时，包含 issue body + clone/readIssue/postReply/closeIssue 命令
- **Forward Prompt**：comment_created 时，包含评论内容 + postReply/readIssue 命令
- **Continue Prompt**：completion check 时，包含未完成原因 + 命令

### ACK 评论

```
Issue Opened:   🔄 **ework-daemon** picked up this issue.
Comment:        ✓ Message forwarded to **ework-daemon** (running).
Broadcast:      ✓ Message broadcasted to: **ework-daemon, other-agent**.
New Session:    🔄 **new-agent** joined the conversation.
Completion:     ✅ **ework-daemon** completed (15 min) / ❌ **ework-daemon** failed (5 min)
```

### 大内容处理

内容超过 4000 字符 → 写入 `{workdir}/.ework-daemon/{filename}`，prompt 中替换为文件读取指令。

### Reaction 系统

消息开始 → eyes (👀) | 完成 → 移除 eyes → +1 (成功) / -1 (失败)

## 消息路由

```
评论到达 → bot 自己 → 丢弃 (防递归)
        → 已处理 (sourceCommentId 去重) → 丢弃
        → 有 @name → 定向投递 (找/创建 session)
        → 无 @ → 广播所有 session
```

## Server 端点

### Webhook

| 路由 | 说明 |
|------|------|
| `POST /webhook/gitea` | Gitea webhook |
| `POST /webhook` | Gitea 兼容路由 (alias) |
| `POST /webhook/plane` | Plane webhook (待实现) |

### REST API

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/api/status` | 守护进程状态 |
| GET | `/api/issues` | 列出所有 issue |
| GET | `/api/issues/:id` | Issue 详情 + sessions |
| GET | `/api/sessions` | 列出所有 session |
| GET | `/api/sessions/:id` | Session 详情 |
| GET | `/api/sessions/:id/messages` | Session 消息 |
| GET | `/api/queue` | Pending 队列深度 |
| GET | `/api/processes` | 活跃进程 |
| PATCH | `/api/messages/:id/retry` | 重试失败消息 |
| DELETE | `/api/processes/:key` | 强制停止进程 |

## CLI

```
ework-daemon status                    守护进程概览
ework-daemon issues                    列出所有 issue
ework-daemon issue <id>                Issue 详情 + sessions
ework-daemon sessions                  列出所有 session
ework-daemon session <id>              Session 详情
ework-daemon messages <sessionId>      Session 消息列表
ework-daemon queue                     Pending 队列深度
ework-daemon processes                 活跃进程
ework-daemon retry <msgId>             重试失败消息
ework-daemon stop <key>                强制停止进程
```

## 组装 (index.ts)

```
loadConfig()
  ├── GiteaClient → GiteaTracker
  ├── trackers = Map<string, IssueTracker>
  ├── Store(config.db.path)          → SQLite 三表
  ├── Engine(config, store, trackers) → 核心引擎
  │     └── startGlobalObserver + recover()
  ├── createServer(config, store, engine, trackers)
  └── SIGTERM/SIGINT → engine.destroy() + store.close()
```

## 目录结构

```
ework-daemon/
├── DESIGN.md                          # 本文件
├── README.md
├── BUGS.md
├── SKILL.md
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                       # 入口，组装所有模块
│   ├── config.ts                      # Zod schema，test/production 双模式
│   ├── server.ts                      # Webhook 路由 + REST API
│   ├── opencode.ts                    # Engine 核心 (1101L)
│   ├── op.ts                          # Store 持久层 (490L)
│   ├── gitea.ts                       # Gitea REST 客户端
│   ├── cli.ts                         # CLI 工具
│   └── trackers/
│       ├── types.ts                   # 三实体接口 + IssueTracker 抽象
│       └── gitea-tracker.ts           # Gitea IssueTracker 实现
├── references/
│   ├── issue-systems.md              # 外部 issue 系统调研
│   └── api-reference.md              # API 参考
└── test/
    └── ework-daemon-test.db                  # 测试 DB
```

## 配置

```typescript
// config.ts — Zod schema
{
  env: "test" | "production",
  gitea: { url, token, webhookSecret },
  bot: { username, token },
  daemon: { port, host },
  opencode: { binary, baseWorkdir },
  db: { path },
  completionCheck?: { apiKey, baseURL, model }  // 可选 LLM 完成检查
}
```

环境变量驱动，test 模式有安全默认值，production 必须 `.env` 提供全部配置。

## 技术选型

| 选择 | 理由 |
|------|------|
| TypeScript | 主流 AI 工具生态兼容 |
| Bun runtime | 快速启动，内置 TS + SQLite 支持 |
| 原生 HTTP (Bun.serve) | 无框架依赖，daemon 逻辑简单 |
| SQLite (bun:sqlite) | 零运维嵌入式 DB，WAL 模式 |
| Zod | 运行时配置校验 |

## 待实现

- **PlaneTracker**: `/webhook/plane` 路由已预留，需要实现 PlaneTracker 类
