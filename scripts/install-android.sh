#!/usr/bin/env bash
# install-android.sh [debug|release|apk路径] [设备序列号]   —— 构建机本机（Windows，Git Bash）用 adb 安装 APK 到手机
# 手机插到构建机开 USB 调试；或开无线调试后先执行: adb connect <手机IP>:<端口>
# 本脚本只用本机 adb 直装，不做远程转发；MacBook 侧重装请重跑 build-android-remote.sh（远端构建完会自动装机）。
#
# ⚠ 本机专属配置（adb 路径、设备序列号等）不入库：复制 scripts/build-env.example.sh
#   为 scripts/build-env.sh 并填写（已 gitignore）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/build-env.sh" ] && . "$SCRIPT_DIR/build-env.sh"

ARG="${1:-release}"
SERIAL="${2:-${ANDROID_SERIAL:-}}"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 默认取 gradle 产物（build-android.sh 的输出位置）；也接受 debug/release 或任意 APK 路径
case "$ARG" in
  debug)   APK='android/app/build/outputs/apk/debug/app-debug.apk' ;;
  release) APK='android/app/build/outputs/apk/release/app-release.apk' ;;
  *)       APK="$ARG" ;;
esac

# adb：优先 PATH，否则回退到 BUILD_ADB_POSIX（构建机上的安装位置，见 scripts/build-env.example.sh）
if command -v adb >/dev/null 2>&1; then
  ADB="adb"
elif [ -n "${BUILD_ADB_POSIX:-}" ] && [ -x "$BUILD_ADB_POSIX" ]; then
  ADB="$BUILD_ADB_POSIX"
elif [ -x /c/Softwares/Android/platform-tools/adb.exe ]; then
  ADB=/c/Softwares/Android/platform-tools/adb.exe
else
  echo "找不到 adb：PATH 里没有，BUILD_ADB_POSIX 也未指向可执行文件（见 scripts/build-env.example.sh）"
  exit 1
fi

cd "$ROOT"
if [ ! -f "$APK" ]; then
  echo "找不到 APK: ${APK}"
  echo "先跑 scripts/build-android.sh [debug|release]，或把 APK 路径作为第 1 个参数传入。"
  exit 1
fi
# adb.exe 需要 Windows 路径；pwd -W 是 Git Bash 的 Windows 路径输出
APK_WIN="$(cd "$(dirname "$APK")" && pwd -W)/$(basename "$APK")"

if [ -n "$SERIAL" ]; then
  echo "==> 安装到设备 ${SERIAL} ..."
  "$ADB" -s "$SERIAL" install -r "$APK_WIN"
else
  # adb devices 输出带 \r，先清洗；取状态为 device 的序列号
  SERIALS="$("$ADB" devices | tr -d '\r' | awk 'NR>1 && $2=="device" {print $1}')"
  if [ -z "$SERIALS" ]; then
    echo "未检测到手机。请插线开 USB 调试，或开无线调试后执行："
    echo "    $ADB connect <手机IP>:<端口>"
    echo "连接后重跑本脚本。"
    exit 1
  fi
  for S in $SERIALS; do
    echo "==> 安装到设备 ${S} ..."
    "$ADB" -s "$S" install -r "$APK_WIN"
  done
fi
echo "完成，手机应用列表打开 HermesChat 即可。"
