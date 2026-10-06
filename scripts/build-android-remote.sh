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
# ⚠ 但仅重定向 stdio 还不够（2026-10-06 实证）：Windows 下 ssh 通道的管道句柄
#   会沿进程树被**所有后代**继承（不只是 stdio），新孵化的 adb daemon
#   （daemon not running; starting now）同样把通道挂死。所以本地侧做看门狗：
#   远端 cat 完日志后会打一行哨兵（带构建退出码），本地见到哨兵即认为完成，
#   主动杀掉本地 ssh 进程收通道，绝不依赖通道自己关闭。
REMOTE_LOG_POSIX="${BUILD_TMP_DIR:-C:/Users/Public}/hermes-android-build.log"
SENTINEL="HERMES_REMOTE_BUILD_DONE"
LOCAL_LOG="$(mktemp -t hermes-android-build)"
trap 'rm -f "$LOCAL_LOG"' EXIT

# 后台起 ssh：远端构建日志经 cat 整体回显到本地日志文件，末尾是哨兵行
ssh "$REMOTE_HOST" "cd /d $REMOTE_DIR & (git pull --ff-only origin main || (git reset --hard origin/main >nul & git pull --ff-only origin main)) & \"$REMOTE_BASH\" -l -c \"scripts/build-android.sh $FLAVOR > '$REMOTE_LOG_POSIX' 2>&1; RC=\$?; cat '$REMOTE_LOG_POSIX'; echo $SENTINEL rc=\$RC; exit \$RC\"" >"$LOCAL_LOG" 2>&1 &
SSH_PID=$!

# 等哨兵（完成）或 ssh 自己死掉（网络中断等）
while ! grep -q "$SENTINEL" "$LOCAL_LOG" 2>/dev/null; do
  kill -0 "$SSH_PID" 2>/dev/null || break
  sleep 5
done
# 通道可能被 daemon 句柄挂住：主动收掉（此刻远端命令必然已结束）
kill "$SSH_PID" 2>/dev/null || true
wait "$SSH_PID" 2>/dev/null || true
cat "$LOCAL_LOG"

if ! grep -q "$SENTINEL" "$LOCAL_LOG"; then
  echo "远端构建未跑完（ssh 中断），以上为已收到的日志" >&2
  exit 1
fi
BUILD_RC="$(sed -n "s/.*$SENTINEL rc=\([0-9][0-9]*\).*/\1/p" "$LOCAL_LOG" | tail -1)"
if [ "$BUILD_RC" != "0" ]; then
  echo "远端构建失败（rc=$BUILD_RC）" >&2
  exit "$BUILD_RC"
fi

echo "==> [3/3] 取回 APK"
mkdir -p "$DIST_DIR"
scp "$REMOTE_HOST:$REMOTE_DIR_FWD/$APK_FWD" "$DIST_DIR/$APK_NAME"
ls -lh "$DIST_DIR/$APK_NAME"
echo "完成。如需重新安装到手机：在构建机本机执行 scripts/install-android.sh（本机 adb 直装）"
