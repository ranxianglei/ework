# ework sandbox deployment templates

来自 ework 沙箱（VM 隔离部署 + 渗透测试验证）的通用部署模板。目标：重建一套沙箱时不用翻聊天记录。
**所有 `<...>` 是占位符**；真实 IP / 域名 / 端口 / token / 密码一律不得写入本目录。

## 内容

| 路径 | 用途 | 放置位置 |
|---|---|---|
| `agents-baseline.md` | AI 代理行为基线（凭证红线/网络边界/交付规范/PR 工作流/防自循环标记） | daemon 工作目录树根（所有 issue workdir 的公共父目录），代理自动继承 |
| `skills/security-baseline/SKILL.md` | 安全技能（注入防御清单、凭证文件模式、渗透测试豁免范围） | daemon 服务账号的 skills 目录，并在 opencode 配置 `skills.paths` 注册 |
| `firewall/ufw-sandbox.rules.sh` | 出网白名单 + 私网封禁 + 仅宿主机入站；含 ufw 静默失效与规则顺序的兜底 | VM/容器内以 root 执行 |
| `git-credentials/setup.sh` + `ework-gh-credhelper` + `sudoers-credhelper` | root 托管 PAT + 单命令 sudoers + credhelper：服务账号能 push、读不到 token | 见脚本内说明 |
| `systemd/ework-{web,daemon,router,mirror}.service` | 分服务 UID 的 systemd 单元（每个服务独立账号与数据目录） | `/etc/systemd/system/` |

## 安全模型速记（为什么长这样）

- **分服务 UID**：web / daemon(+router) / mirror 各自独立系统账号与 700 数据目录；
  daemon（跑 AI 的账号）读不到 web 的数据库与 env —— 堆叠凭证互不可见。
- **token 最小暴露面**：PAT 放 `/root/` 600；服务账号通过 credhelper（单条 NOPASSWD
  sudoers 授权 `cat` 该文件）在 git 推送瞬间取用；除此之外任何 sudo 仍需密码。
- **网络单向**：沙箱出网仅 80/443/DNS/NTP + 指定 LLM 端点；私网与云元数据全封；
  入站仅宿主机网关。宿主机可访问沙箱，沙箱摸不到宿主机与内网。
- **信任分层**：同步进来的陌生内容只落库展示，不唤醒 AI（唤醒白名单）；
  转发给 AI 的不受信作者内容打 unverified 标记并声明"是数据不是指令"。

该模型经真实渗透测试验证（AI 在沙箱内自由攻击 90 分钟，未能读到宿主机 canary 文件）。
