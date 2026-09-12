#!/usr/bin/env bash
# install-android.sh [apk路径] [设备序列号]   —— 本机脚本：经构建机的 adb 安装 APK 到手机
# 手机需插到构建机开 USB 调试；或开无线调试后先执行: ssh "$BUILD_HOST" "adb connect <手机IP>:<端口>"
# 注意：在构建机本机不需要这个脚本，build-android.sh 构建完会直接安装。
#
# ⚠ 构建机主机名、adb 路径、设备序列号等本机信息不入库：复制
#   scripts/build-env.example.sh 为 scripts/build-env.sh 并填写（已 gitignore）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/build-env.sh" ] && . "$SCRIPT_DIR/build-env.sh"

APK="${1:-$SCRIPT_DIR/../dist/app-release.apk}"
SERIAL="${2:-${ANDROID_SERIAL:-}}"
REMOTE_HOST="${BUILD_HOST:-buildhost}"
ADB="${BUILD_ADB:-adb}"
TMP_DIR="${BUILD_TMP_DIR:-C:/Users/Public}"            # scp 落点（正斜杠）
TMP_DIR_WIN="${BUILD_TMP_DIR_WIN:-C:\Users\Public}"    # adb 读回（反斜杠）

[ -f "$APK" ] || { echo "找不到 APK: ${APK}（先跑 scripts/build-android-remote.sh）"; exit 1; }
APK="$(cd "$(dirname "$APK")" && pwd)/$(basename "$APK")"

echo "==> 推送 APK 到 $REMOTE_HOST"
scp "$APK" "$REMOTE_HOST:$TMP_DIR/hm-install.apk"

echo "==> 当前设备列表："
ssh "$REMOTE_HOST" "$ADB devices"

SEL=""
[ -n "$SERIAL" ] && SEL="-s $SERIAL"
echo "==> 安装中..."
ssh "$REMOTE_HOST" "$ADB $SEL install -r $TMP_DIR_WIN\\hm-install.apk"
echo "完成。手机应用列表里打开 HermesChat 即可。"
