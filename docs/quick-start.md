# ework 快速入门 / Quick Start

一套自托管 AI 开发工作台:issue 驱动的多 agent 平台 —— web(项目管理+issue) + daemon(agent 引擎) + opencode 运行时,开箱即用。
Self-hosted, issue-driven AI dev workbench: web (projects + issues) + daemon (agent engine) + the opencode runtime, bundled and wired for you.

## 平台支持 / Platform support

| 平台 | 方式 | 状态 |
|------|------|------|
| Linux | npm 原生安装 | ✅ 推荐 |
| Windows / macOS | Docker | ✅ 推荐(本文主角) |
| Windows WSL2 | npm 原生安装 | ✅ 同 Linux |
| Windows 原生 | — | ❌ 暂不支持(服务依赖 glibc + POSIX 环境) |

## Docker 一键启动(Windows/macOS/Linux 通用)

前提:安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)(Windows/macOS)或 docker engine + compose(Linux)。

```bash
# 1. 取代码(或直接从 GitHub 构建,见下)
git clone https://github.com/ranxianglei/ework.git
cd ework/docker

# 2. 配置
cp .env.docker.example .env.docker
#   必填三项:WORK_TOKEN / WORK_COOKIE_SECRET / GITEA_WEBHOOK_SECRET(生成:openssl rand -hex 16)
#   强烈建议填模型端点(任何 OpenAI 兼容 /v1):
#   WORK_LLM_BASE_URL=http://host.docker.internal:8199/v1   ← 宿主机上的模型服务
#   WORK_LLM_MODEL / WORK_LLM_API_KEY 按端点填
$EDITOR .env.docker

# 3. 启动(首次构建约 3-5 分钟;之后秒级)
docker compose up -d

# 4. 打开
#   http://localhost:3002   账号 op,密码 = WORK_TOKEN
```

不想 clone?直接从 GitHub 构建:

```bash
docker build -t ework -f docker/Dockerfile https://github.com/ranxianglei/ework.git
docker run -d --name ework -p 3002:3002 -p 3101:3101 \
  --env-file .env.docker --add-host host.docker.internal:host-gateway \
  -v ework-data:/data ework
```

镜像内置:ework-web + ework-daemon + ework-router + **opencode-stable**(运行时)+ **opencode-acp / omo-stable / opencode-ework**(插件全家桶),首次启动自动完成 bot 账号创建、PAT 签发、模型配置。

## Linux / WSL2 原生安装

```bash
# 前置:node ≥ 18(npm)、bun ≥ 1.1(curl -fsSL https://bun.sh/install | bash)
npm install -g ework-aio
ework-aio install          # PID-file 模式,不需要 systemd;要 systemd 用 ework-aio install systemd
ework-aio status
```

安装器会引导同样的初始化(含 opencode 插件合并);详见 `packages/aio/README.md`。

## 启动之后

1. **登录** → 建项目(或从 Gitea/GitHub 导入)。
2. **发一个 issue** 描述你要做的事 —— daemon 会自动接单,agent 在隔离的 worktree 里干活,进展和产物回帖到 issue(回复带 `[bot]` 前缀)。
3. 在 issue 里持续对话即可驱动它;工具栏可切模型、翻译、停止。

## 日常运维

```bash
docker compose logs -f          # 看日志(容器内 supervisord 管 web/daemon/router)
docker compose restart          # 重启
docker volume inspect ework_ework-data   # 所有状态(DB/附件/agent workdir)都在这个卷里,备份它即可
```

原生安装对应:`ework-aio status` / `ework-aio restart` / `ework-aio config get`。

## 常见问题

- **agent 报模型错误** → 检查 `WORK_LLM_BASE_URL` 是否从容器内可达(`docker exec ework curl -s http://host.docker.internal:PORT/v1/models`);Linux 需保留 compose 里的 `host-gateway` 映射。
- **想用托管 API**(DeepSeek/OpenAI 兼容)→ 同样走 `WORK_LLM_*` 三个变量,端点带 `/v1`。
- **升级** → `git pull && docker compose up -d --build`(镜像默认跟踪 npm 最新版;要锁版本用 `--build-arg EWORK_WEB_VERSION=...` 等)。

## Troubleshooting / 故障排查

四种最常见的故障:LLM 不可达、端口冲突、数据迁移(备份/恢复)、升级钉版本。
The four most common failure modes and their fixes.

### LLM 不可达 / Model endpoint unreachable

表现:agent 回复模型错误,或请求长时间挂起后超时。

先在容器内验证端点是否可达(端口换成你 `WORK_LLM_BASE_URL` 里的):

```bash
docker exec ework curl -s http://host.docker.internal:8199/v1/models
```

能返回模型列表说明链路正常;卡住或 connection refused 按顺序排查:

- **模型服务绑定在 127.0.0.1** —— 容器内访问不到。把模型服务的 bind 地址改成 `0.0.0.0` 再重启。
- **防火墙 / 安全组**拦了该端口(宿主机 firewalld/ufw,云主机安全组)。
- **Linux 宿主机**必须保留 compose 里的 `extra_hosts: host.docker.internal:host-gateway` 映射(自带 compose 已含);Windows/macOS 的 Docker Desktop 自动提供该名字。
- **`WORK_LLM_BASE_URL` 写错**:漏 `/v1` 后缀、端口不对等。

### 端口冲突 / Port conflict

表现:`docker compose up` 报 `Bind for 0.0.0.0:3002 failed: port is already allocated`;或页面能打开但显示的是别的服务。

查宿主机上谁占了端口:

```bash
ss -lntp | grep -E ':(3002|3101)\s'
```

改法:改 `docker/docker-compose.yml` 里映射的左侧宿主端口(右侧容器端口固定不动):

```yaml
ports:
  - "4002:3002"   # web UI + Gitea-compat API
  - "4101:3101"   # daemon webhook receiver
```

然后 `docker compose up -d`。注意:如果 3101 的 webhook 回调走公网(反向代理),外部回调地址要同步改。

### 数据迁移 / Backup & restore

所有状态(web DB、daemon DB、附件、agent workdir、opencode 配置)都在 `ework-data` 卷的 `/data` 下,备份/恢复就是 tar 这个卷的内容:

```bash
# 查实际卷名(带项目名前缀,随 compose 运行目录变化)
docker volume ls | grep data

# 备份(先停容器,避免边写边导出)
docker compose down
docker run --rm -v ework-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/ework-data-$(date +%Y%m%d).tar.gz -C /data .

# 恢复(换成你的备份文件名)
docker compose down
docker run --rm -v ework-data:/data -v "$PWD":/backup alpine \
  tar xzf /backup/ework-data-20260916.tar.gz -C /data
docker compose up -d
```

命令里的 `ework-data` 替换为 `docker volume ls` 查到的实际名称。

### 升级 / Upgrade

镜像默认跟踪 npm 最新版(`latest`),常规升级:

```bash
git pull && docker compose up -d --build
```

要钉版本(可复现构建),build 时传 build-arg。可用的 arg(默认都是 `latest`):
`EWORK_WEB_VERSION` / `EWORK_DAEMON_VERSION` / `EWORK_ROUTER_VERSION` / `OPENCODE_STABLE_VERSION` / `OPENCODE_EWORK_VERSION`:

```bash
docker compose build \
  --build-arg EWORK_WEB_VERSION=0.10.135 \
  --build-arg EWORK_DAEMON_VERSION=0.10.135 \
  --build-arg EWORK_ROUTER_VERSION=0.10.135
docker compose up -d
```

正确姿势是「钉版本 → build → up -d 重建容器」三步;数据在卷里不受影响,常规升级无需备份(跨大版本建议先备份)。验证:`docker exec ework npm ls -g --depth=0 | grep ework`。
