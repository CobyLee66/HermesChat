#!/usr/bin/env bash
# build-android.sh [debug|release]   —— 在 Mac 上一键驱动 构建机 构建 Android APK
# 流程：本地改动推送 GitHub -> 构建机 git pull -> npm install（增量）-> gradlew 构建
#       -> APK 取回 dist/ -> 检测到 adb 设备时直接安装到手机
set -euo pipefail

FLAVOR="${1:-release}"           # debug | release
REMOTE_HOST="构建机"             # ~/.ssh/config 里的别名
REMOTE_DIR='C:\HermesMobile'
ADB='C:\Softwares\Android\platform-tools\adb.exe'
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$LOCAL_DIR/dist"

case "$FLAVOR" in
  debug)   GRADLE_TASK=assembleDebug;   APK_FWD='android/app/build/outputs/apk/debug/app-debug.apk';     APK_NAME=app-debug.apk ;;
  release) GRADLE_TASK=assembleRelease; APK_FWD='android/app/build/outputs/apk/release/app-release.apk'; APK_NAME=app-release.apk ;;
  *) echo "用法: $0 [debug|release]"; exit 1 ;;
esac

cd "$LOCAL_DIR"
echo "==> [1/4] 同步 GitHub"
[ -z "$(git status --porcelain)" ] || { echo "有未提交的改动，请先 git commit"; exit 1; }
git fetch origin -q
AHEAD="$(git rev-list --count origin/main..HEAD)"
if [ "$AHEAD" != "0" ]; then echo "    推送 $AHEAD 个本地提交..."; git push origin main; fi

echo "==> [2/4] 构建机 拉取代码 + 安装 JS 依赖"
# npm ci 不改 lockfile（npm install 会改动导致下次 pull 失败）；pull 失败时先 reset 自愈
ssh "$REMOTE_HOST" "cd /d $REMOTE_DIR & (git pull --ff-only origin main || (git reset --hard origin/main >nul & git pull --ff-only origin main)) & npm ci --no-audit --no-fund --loglevel=error"

echo "==> [3/4] gradlew $GRADLE_TASK"
ssh "$REMOTE_HOST" "cd /d $REMOTE_DIR\\android & gradlew.bat $GRADLE_TASK --console=plain"

echo "==> [4/5] 取回 APK"
mkdir -p "$DIST_DIR"
scp "$REMOTE_HOST:C:/HermesMobile/$APK_FWD" "$DIST_DIR/$APK_NAME"
ls -lh "$DIST_DIR/$APK_NAME"

echo "==> [5/5] 检测 adb 设备并安装"
# adb devices 输出带 \r，先清洗；取状态为 device 的序列号
SERIALS="$(ssh "$REMOTE_HOST" "$ADB devices" | tr -d '\r' | awk 'NR>1 && $2=="device" {print $1}')"
if [ -z "$SERIALS" ]; then
  echo "未检测到手机。请把手机插到 构建机（USB 调试），或开无线调试后执行："
  echo "    ssh $REMOTE_HOST \"$ADB connect <手机IP>:<端口>\""
  echo "之后可单独安装：scripts/install-android.sh $DIST_DIR/$APK_NAME"
else
  REMOTE_APK="C:/HermesMobile/$APK_FWD"
  for S in $SERIALS; do
    echo "    安装到设备 $S ..."
    ssh "$REMOTE_HOST" "$ADB -s $S install -r $REMOTE_APK"
  done
  echo "完成，手机应用列表打开 HermesMobile 即可。"
fi
