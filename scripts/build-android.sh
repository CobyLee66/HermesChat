#!/usr/bin/env bash
# build-android.sh [debug|release]   —— 在 Mac 上一键驱动 构建机 构建 Android APK
# 流程：同步工程 -> 构建机 npm ci（如有变化）-> gradlew 构建 -> APK 取回 dist/
set -euo pipefail

FLAVOR="${1:-release}"           # debug | release
REMOTE_HOST="构建机"             # ~/.ssh/config 里的别名
REMOTE_DIR='C:\HermesMobile'
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$LOCAL_DIR/dist"

case "$FLAVOR" in
  debug)   GRADLE_TASK=assembleDebug;   APK_REL='android\app\build\outputs\apk\debug\app-debug.apk';     APK_NAME=app-debug.apk ;;
  release) GRADLE_TASK=assembleRelease; APK_REL='android\app\build\outputs\apk\release\app-release.apk'; APK_NAME=app-release.apk ;;
  *) echo "用法: $0 [debug|release]"; exit 1 ;;
esac

echo "==> [1/4] 同步工程到 $REMOTE_HOST:$REMOTE_DIR"
cd "$LOCAL_DIR"
tar --exclude='./node_modules' --exclude='./ios' --exclude='./.git' --exclude='./dist' \
    --exclude='./android/.gradle' --exclude='./android/build' --exclude='./android/app/build' \
    -czf - . | ssh "$REMOTE_HOST" "cd /d $REMOTE_DIR & tar -xzf -"

echo "==> [2/4] 安装 JS 依赖（npm ci，锁文件未变时会很快）"
ssh "$REMOTE_HOST" "cd /d $REMOTE_DIR & npm ci --no-audit --no-fund --loglevel=error"

echo "==> [3/4] gradlew $GRADLE_TASK（首次约 25 分钟，增量约几分钟）"
ssh "$REMOTE_HOST" "cd /d $REMOTE_DIR\\android & gradlew.bat $GRADLE_TASK --console=plain"

echo "==> [4/4] 取回 APK"
mkdir -p "$DIST_DIR"
scp "$REMOTE_HOST:$REMOTE_DIR\\$APK_REL" "$DIST_DIR/$APK_NAME"
ls -lh "$DIST_DIR/$APK_NAME"
echo "完成。安装到手机: scripts/install-android.sh $DIST_DIR/$APK_NAME"
