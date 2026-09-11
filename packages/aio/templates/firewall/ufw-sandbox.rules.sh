#!/bin/sh
# ework 沙箱防火墙规则集（模板）
# 目标：VM/容器内可自由折腾，但 (1) 出网仅限任务必需的公网服务与指定内网端点，
#       (2) 内网/私网一律不可达，(3) 入站仅限宿主机侧。
# 用法：替换下方变量后以 root 执行；执行后务必用真实连接验证（见文件末尾注意）。

set -eu

LLM_HOST="<llm-host-ip>"          # LLM 推理端点（vLLM/sglang 宿主机），从沙箱可达
LLM_PORT="<llm-port>"             # 推理服务端口
GIT_PROXY_HOST="<git-proxy-host>" # 可选：git 代理宿主机；不用代理则留空 ""
GIT_PROXY_PORT="20176"
NAT_GW="10.0.2.2"                 # VirtualBox NAT 下宿主机的网关地址

ufw default deny incoming
ufw default deny outgoing

# 出站：本机回环 + DNS/NTP + 公网 http(s)（github、上游 API 走这里）
ufw allow out on lo
ufw allow in on lo
ufw allow out to any port 53 proto udp
ufw allow out 80/tcp
ufw allow out 443/tcp
ufw allow out 123/udp proto udp

# 出站：指定内网端点（LLM、可选 git 代理）——先放行再封私网
[ -n "$LLM_HOST" ] && ufw allow out to "$LLM_HOST" port "$LLM_PORT" proto tcp
[ -n "$GIT_PROXY_HOST" ] && ufw allow out to "$GIT_PROXY_HOST" port "$GIT_PROXY_PORT" proto tcp

# 出站：封死私网与元数据（LLM/代理白名单要写在封禁之前）
ufw deny out to 10.0.0.0/8
ufw deny out to 172.16.0.0/12
ufw deny out to 192.168.0.0/16
ufw deny out to 169.254.0.0/16

# 入站：仅宿主机（NAT 网关）访问本机任意端口；其余默认拒绝
ufw allow from "$NAT_GW"

ufw --force enable
ufw status numbered

# 重要（实战踩坑）：
# 1. 某些 Ubuntu 版本上 `ufw allow out to <ip> port <n>` 显示成功、`ufw status` 也能看到，
#    但规则从未落入 iptables（静默失效）。放行内网端点后必须真实连接验证一次；
#    若不通，直接落 iptables 兜底：
#      iptables -I ufw-user-output 1 -d "$LLM_HOST"/32 -p tcp --dport "$LLM_PORT" -j ACCEPT
# 2. ufw 重复添加同目标规则会去重后追加到已有 DENY 之后（顺序失效），改规则先 delete 再 insert 1。
# 3. `ufw enable` 在交互终端会卡确认，脚本里用 --force。
# 4. 启用后宿主机端口转发（如 host:1193→guest:3002）会被默认入站拒绝打断——
#    流量源是 NAT 网关地址，上面的 allow from $NAT_GW 即为修复。
