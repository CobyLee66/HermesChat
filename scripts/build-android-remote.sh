#!/usr/bin/env bash
# build-android-remote.sh [debug|release]   —— 在本机一键驱动远端构建机出 Android APK
# 流程：本地改动推送 GitHub -> 构建机 git pull -> 远端执行 scripts/build-android.sh（构建+安装）
#       -> APK 取回 dist/。本机无 Android 工具链时使用此脚本。
#
# ⚠ 构建机主机名等本机信息不入库：复制 scripts/build-env.example.sh 为
#   scripts/build-env.sh 并填写（该文件已 gitignore），或直接用环境变量覆盖。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/build-env.sh" ] && . "$SCRIPT_DIR/build-env.sh"

FLAVOR="${1:-release}"           # debug | release
REMOTE_HOST="${BUILD_HOST:-buildhost}"                    # ~/.ssh/config 里的别名
REMOTE_DIR="${BUILD_DIR:-C:\HermesChat}"                  # 构建机上的工程目录
REMOTE_DIR_FWD="${BUILD_DIR_FWD:-C:/HermesChat}"          # 同上（scp 用正斜杠）
# Git for Windows 自带的 bash（远端 Windows 的 cmd 里 bash 不一定在 PATH）
REMOTE_BASH="${BUILD_BASH:-C:\Program Files\Git\bin\bash.exe}"
LOCAL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$LOCAL_DIR/dist"

case "$FLAVOR" in
  debug)   APK_FWD='android/app/build/outputs/apk/debug/app-debug.apk';     APK_NAME=app-debug.apk ;;
  release) APK_FWD='android/app/build/outputs/apk/release/app-release.apk'; APK_NAME=app-release.apk ;;
  *) echo "用法: $0 [debug|release]"; exit 1 ;;
esac

cd "$LOCAL_DIR"
echo "==> [1/3] 同步 GitHub"
[ -z "$(git status --porcelain)" ] || { echo "有未提交的改动，请先 git commit"; exit 1; }
git fetch origin -q
AHEAD="$(git rev-list --count origin/main..HEAD)"
if [ "$AHEAD" != "0" ]; then echo "    推送 $AHEAD 个本地提交..."; git push origin main; fi

echo "==> [2/3] 构建机拉取代码并构建（scripts/build-android.sh）"
# npm ci 不改 lockfile（npm install 会改动导致下次 pull 失败）；pull 失败时先 reset 自愈
# ⚠ 构建的 stdio 必须先落远端日志文件再回显，不能直接连 ssh 通道：
#   gradle 新孵化的 daemon 会继承其启动时会话的 stdout/stderr 句柄——若是 ssh
#   通道句柄，daemon 常驻导致通道永远等不到 EOF，表现为「构建早已完成但脚本
#   卡死」（复用既有 daemon 时无此问题，故该坑时好时坏）。
REMOTE_LOG_POSIX="${BUILD_TMP_DIR:-C:/Users/Public}/hermes-android-build.log"
ssh "$REMOTE_HOST" "cd /d $REMOTE_DIR & (git pull --ff-only origin main || (git reset --hard origin/main >nul & git pull --ff-only origin main)) & \"$REMOTE_BASH\" -l -c \"scripts/build-android.sh $FLAVOR > '$REMOTE_LOG_POSIX' 2>&1; RC=\$?; cat '$REMOTE_LOG_POSIX'; exit \$RC\""

echo "==> [3/3] 取回 APK"
mkdir -p "$DIST_DIR"
scp "$REMOTE_HOST:$REMOTE_DIR_FWD/$APK_FWD" "$DIST_DIR/$APK_NAME"
ls -lh "$DIST_DIR/$APK_NAME"
echo "完成。如需重新安装到手机：在构建机本机执行 scripts/install-android.sh（本机 adb 直装）"
