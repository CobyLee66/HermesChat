#!/usr/bin/env bash
# build-android-remote.sh [debug|release]   —— 在 Mac 上一键驱动 构建机 构建 Android APK
# 流程：本地改动推送 GitHub -> 构建机 git pull -> 远端执行 scripts/build-android.sh（构建+安装）
#       -> APK 取回 dist/。本机无 Android 工具链时使用此脚本。
set -euo pipefail

FLAVOR="${1:-release}"           # debug | release
REMOTE_HOST="构建机"             # ~/.ssh/config 里的别名
REMOTE_DIR='C:\HermesChat'
# Git for Windows 自带的 bash（远端 Windows 的 cmd 里 bash 不一定在 PATH）
REMOTE_BASH='C:\Program Files\Git\bin\bash.exe'
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
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

echo "==> [2/3] 构建机 拉取代码并构建（scripts/build-android.sh）"
# npm ci 不改 lockfile（npm install 会改动导致下次 pull 失败）；pull 失败时先 reset 自愈
ssh "$REMOTE_HOST" "cd /d $REMOTE_DIR & (git pull --ff-only origin main || (git reset --hard origin/main >nul & git pull --ff-only origin main)) & \"$REMOTE_BASH\" -l scripts/build-android.sh $FLAVOR"

echo "==> [3/3] 取回 APK"
mkdir -p "$DIST_DIR"
scp "$REMOTE_HOST:C:/HermesChat/$APK_FWD" "$DIST_DIR/$APK_NAME"
ls -lh "$DIST_DIR/$APK_NAME"
echo "完成。如需重新安装到手机：scripts/install-android.sh $DIST_DIR/$APK_NAME"
