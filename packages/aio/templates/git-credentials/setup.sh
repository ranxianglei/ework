#!/bin/bash
# ework 沙箱 git 推送凭证安装（模板）
# 目标：daemon 服务账号可 git push / 开 PR，但物理上读不到 token（root 托管）。
# 前提：已按分服务 UID 模型建好服务账号（如 ework-daemon），token 为
#       fine-grained PAT（只授权目标仓库，Contents+Pull requests+Issues 读写）。
# 用法：填好 SERVICE_USER 与 TOKEN 来源后以 root 执行。
set -eu

SERVICE_USER="<service-user>"     # 需要推送权限的服务账号（如 ework-daemon）
TOKEN_SRC="<token-source-file>"   # 存放 PAT 的临时文件（安装后删除）
TOKEN_DST="/root/ework-gh-pat"

install -m 755 "$(dirname "$0")/ework-gh-credhelper" /usr/local/bin/ework-gh-credhelper
install -m 440 -o root -g root "$(dirname "$0")/sudoers-credhelper" /etc/sudoers.d/ework-credhelper
sed -i "s/^ework-daemon /$SERVICE_USER /" /etc/sudoers.d/ework-credhelper
visudo -cf /etc/sudoers.d/ework-credhelper

install -m 600 -o root -g root "$TOKEN_SRC" "$TOKEN_DST"
rm -f "$TOKEN_SRC"

sudo -u "$SERVICE_USER" git config --global credential.helper \
  '!/usr/local/bin/ework-gh-credhelper'
sudo -u "$SERVICE_USER" git config --global user.name  "$SERVICE_USER"
sudo -u "$SERVICE_USER" git config --global user.email "$SERVICE_USER@users.noreply.github.com"

# 验证：以下两条都必须成功（服务账号可推；但读不到 token 文件本体）
sudo -u "$SERVICE_USER" bash -c \
  'printf "protocol=https\nhost=github.com\n\n" | /usr/local/bin/ework-gh-credhelper | grep -q password=github_pat'
sudo -u "$SERVICE_USER" test ! -r "$TOKEN_DST" && echo "OK: token unreadable by $SERVICE_USER"
