# Issue Tracking System Research

调研目标：为 ework-daemon 寻找比 Gitea Issues 更强大的 issue 系统，重点是 API + Webhook + AI Agent 集成能力。

## 评估标准

| 维度 | 权重 | 说明 |
|------|------|------|
| API 完整性 | 高 | REST/GraphQL，覆盖 issues、comments、webhooks |
| Webhook 支持 | 高 | 原生 webhook，事件类型丰富，HMAC 签名 |
| AI Agent 集成 | 高 | 官方 Agent SDK / Agent Session API |
| 自托管 | 中 | Docker 部署，数据自主 |
| 开源 | 中 | MIT/AGPL 等开源协议 |
| UX 速度 | 中 | 响应速度、交互流畅度 |

## 排名

### 🥇 Tier 1 — 最佳 Agent 集成

#### Plane.so
- **开源**: AGPL-3.0，可自托管
- **部署**: Docker Compose 一键部署
- **API**: REST，180+ 端点，完整 CRUD
- **Webhook**: 原生支持，HMAC-SHA256 签名，自动重试
- **Agent SDK**: ✅ **官方 Agent SDK** — OAuth App 注册为 @mention-able agent，接收 `AgentRun` webhook，通过 typed activities 回复
- **AI 功能**: v2.4+ 自带 AI 助手（self-hosted 可用自己的模型）
- **特点**: 项目管理全功能（Epics、Cycles、Modules、Views）
- **适用**: 自托管首选，Gitea Issues 的直接升级

#### Linear
- **开源**: ❌ SaaS only
- **API**: GraphQL，Sub-100ms UX
- **Webhook**: 支持，事件类型丰富
- **Agent 集成**: Agent Session API（dev preview）— 可创建 session 与 AI 交互
- **免费额度**: 250 issues（偏少）
- **特点**: 极致 UX 速度，键盘优先设计
- **适用**: SaaS 首选，适合小团队

### 🥈 Tier 2 — 成熟稳定

#### GitHub Issues
- **API**: REST + GraphQL
- **Webhook**: 完善
- **Agent**: 无官方 Agent SDK，但 Actions + API 可实现类似功能
- **特点**: 生态最大，Actions 集成

#### GitLab Issues
- **API**: REST + GraphQL
- **Webhook**: 完善
- **Agent**: 无官方 SDK
- **自托管**: ✅ CE 版本

#### Shortcut (formerly Clubhouse)
- **API**: REST，设计优雅
- **Webhook**: 支持
- **特点**: 面向开发团队的故事管理

#### Gitea Issues（当前）
- **API**: REST，基本够用
- **Webhook**: 支持，事件类型有限
- **Agent**: 无
- **自托管**: ✅
- **局限**: issue 功能较基础，无 AI 集成

### 🥉 Tier 3 — 可用但有短板

| 系统 | API | Webhook | Agent | 自托管 | 备注 |
|------|-----|---------|-------|--------|------|
| Height | REST | ✅ | AI 内置 | ❌ | AI 原生但 SaaS |
| YouTrack | REST | ✅ | 无 | ✅ | JetBrains 出品 |
| Jira | REST | ✅ | 无 | ✅ (DC) | 功能最全但笨重 |
| Taiga | REST | ✅ | 无 | ✅ | 敏捷项目管理 |

### ❌ Tier 4 — 不适合（无原生 Webhook）

Redmine、Bugzilla、MantisBT、Fossil — 需要轮询或插件，不适合实时 Agent 集成。

## ework-daemon 集成方案

### 推荐：Plane.so（自托管）

**集成路径**:
1. 部署 Plane.so Docker 实例
2. 注册 ework-daemon 为 OAuth App → 获得 Agent 身份
3. 用户在 issue 中 @mention ework-daemon → Plane 发送 `AgentRun` webhook
4. ework-daemon 收到 webhook → 执行 opencode → 通过 API 回复（typed activity）
5. 完成 → 更新 issue status

**vs 当前 Gitea 方案**:
- Gitea: 每条评论都触发 webhook → ework-daemon 需自行过滤 bot 评论
- Plane: @mention 触发 → 天然去重，ework-daemon 只在被召唤时响应
- Plane Agent SDK: 官方 typed activities → 不需要 bot 账号发评论

### 备选：Linear（SaaS）

适合不想自托管的场景。GraphQL API + Agent Session API。免费额度 250 issues 可能不够。

---

*调研日期: 2026-05-31*
