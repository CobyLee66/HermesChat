#!/usr/bin/env bash
# build-desktop-remote.sh —— 在本机一键驱动远端构建机出 Windows 安装包
# 流程：本地改动推送 GitHub -> 构建机 git pull -> 远端执行 scripts/build-windows.sh
#       （npm ci + electron-builder）-> 安装包取回 dist-desktop/。
#       本机无 Windows 打包能力时使用此脚本；构建机本地直接跑 build-windows.sh。
#
# ⚠ 构建机主机名等本机信息不入库：复制 scripts/build-env.example.sh 为
#   scripts/build-env.sh 并填写（该文件已 gitignore），或直接用环境变量覆盖。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/build-env.sh" ] && . "$SCRIPT_DIR/build-env.sh"

REMOTE_HOST="${BUILD_HOST:-buildhost}"                    # ~/.ssh/config 里的别名
REMOTE_DIR="${BUILD_DIR:-C:\HermesChat}"                  # 构建机上的工程目录
REMOTE_DIR_FWD="${BUILD_DIR_FWD:-C:/HermesChat}"          # 同上（scp 用正斜杠）
# Git for Windows 自带的 bash（远端 Windows 的 cmd 里 bash 不一定在 PATH）
REMOTE_BASH="${BUILD_BASH:-C:\Program Files\Git\bin\bash.exe}"
LOCAL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$LOCAL_DIR/dist-desktop"

cd "$LOCAL_DIR"
echo "==> [1/3] 同步 GitHub"
[ -z "$(git status --porcelain)" ] || { echo "有未提交的改动，请先 git commit"; exit 1; }
git fetch origin -q
AHEAD="$(git rev-list --count origin/main..HEAD)"
if [ "$AHEAD" != "0" ]; then echo "    推送 $AHEAD 个本地提交..."; git push origin main; fi

echo "==> [2/3] 构建机拉取代码并构建 Windows 安装包（scripts/build-windows.sh）"
# npm ci 不改 lockfile（npm install 会改动导致下次 pull 失败）；pull 失败时先 reset 自愈
ssh "$REMOTE_HOST" "cd /d $REMOTE_DIR & (git pull --ff-only origin main || (git reset --hard origin/main >nul & git pull --ff-only origin main)) & \"$REMOTE_BASH\" -l scripts/build-windows.sh"

echo "==> [3/3] 取回安装包"
mkdir -p "$DIST_DIR"
scp "$REMOTE_HOST:$REMOTE_DIR_FWD/dist-desktop/*.exe" "$DIST_DIR/" || \
  echo "警告：未取回 exe（检查远端构建日志）"
ls -lh "$DIST_DIR" | head -10
echo "完成。dist-desktop/ 下 Setup exe 即 Windows 安装包（未签名，首次运行选「仍要运行」）。"
