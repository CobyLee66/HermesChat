#!/usr/bin/env bash
# install-android.sh [apk路径] [设备序列号]   —— 通过 构建机 的 adb 安装 APK 到手机
# 手机需插到 构建机 开 USB 调试；或开无线调试后先用: ssh 构建机 "adb connect <手机IP>:<端口>"
set -euo pipefail

APK="${1:-$(dirname "$0")/../dist/app-release.apk}"
SERIAL="${2:-}"
REMOTE_HOST="构建机"
ADB='C:\Softwares\Android\platform-tools\adb.exe'

APK="$(cd "$(dirname "$APK")" && pwd)/$(basename "$APK")"
[ -f "$APK" ] || { echo "找不到 APK: $APK（先跑 scripts/build-android.sh）"; exit 1; }

echo "==> 推送 APK 到 $REMOTE_HOST"
scp "$APK" "$REMOTE_HOST:C:/Users/Public/hm-install.apk"

echo "==> 当前设备列表："
ssh "$REMOTE_HOST" "$ADB devices"

SEL=""
[ -n "$SERIAL" ] && SEL="-s $SERIAL"
echo "==> 安装中..."
ssh "$REMOTE_HOST" "$ADB $SEL install -r C:\\Users\\Lucy\\hm-install.apk"
echo "完成。手机应用列表里打开 HermesMobile 即可。"
