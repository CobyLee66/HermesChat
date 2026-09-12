#!/usr/bin/env bash
# build-android.sh [debug|release] [--no-npm]   —— 在本机（Windows，Git Bash）构建并安装 Android APK
# 仅做：npm ci -> gradlew 构建 -> 检测到 adb 设备则安装。不含任何 git 同步；
# 从本机远程驱动构建机的完整流程见 scripts/build-android-remote.sh
set -euo pipefail

FLAVOR="release"
DO_NPM=1
for arg in "$@"; do
  case "$arg" in
    debug|release) FLAVOR="$arg" ;;
    --no-npm) DO_NPM=0 ;;
    *) echo "用法: $0 [debug|release] [--no-npm]"; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
case "$FLAVOR" in
  debug)   GRADLE_TASK=assembleDebug;   APK_PATH='android/app/build/outputs/apk/debug/app-debug.apk' ;;
  release) GRADLE_TASK=assembleRelease; APK_PATH='android/app/build/outputs/apk/release/app-release.apk' ;;
esac

# adb：优先 PATH，否则回退到 BUILD_ADB_POSIX（构建机上的安装位置，见 scripts/build-env.example.sh）
if command -v adb >/dev/null 2>&1; then
  ADB="adb"
else
  ADB="${BUILD_ADB_POSIX:-/c/Softwares/Android/platform-tools/adb.exe}"
fi

cd "$ROOT"

if [ "$DO_NPM" = 1 ]; then
  echo "==> [1/3] 检查 JS 依赖"
  # npm ci 每次都会删掉整个 node_modules 重装，很慢。
  # npm 安装后会在 node_modules/.package-lock.json 留标记；
  # package.json / package-lock.json 都没比它新，说明依赖没变，直接跳过。
  if [ -f node_modules/.package-lock.json ] \
     && [ ! package-lock.json -nt node_modules/.package-lock.json ] \
     && [ ! package.json -nt node_modules/.package-lock.json ]; then
    echo "    依赖未变化，跳过 npm ci"
  else
    # Android 构建不需要 Electron 运行时二进制（桌面打包才用），跳过省 ~200MB 下载
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund --loglevel=error
  fi
else
  echo "==> [1/3] 跳过 npm（--no-npm）"
fi

echo "==> [2/3] gradlew $GRADLE_TASK"
# Git Bash 下通过 cmd 调 gradlew.bat
(cd android && cmd //c "gradlew.bat $GRADLE_TASK --console=plain")
ls -lh "$APK_PATH"

echo "==> [3/3] 检测 adb 设备并安装"
# adb devices 输出带 \r，先清洗；取状态为 device 的序列号
SERIALS="$("$ADB" devices | tr -d '\r' | awk 'NR>1 && $2=="device" {print $1}')"
if [ -z "$SERIALS" ]; then
  echo "未检测到手机。请插线开 USB 调试，或开无线调试后执行："
  echo "    $ADB connect <手机IP>:<端口>"
  echo "连接后重跑本脚本（可加 --no-npm 跳过依赖安装）。"
else
  # adb.exe 需要 Windows 路径；pwd -W 是 Git Bash 的 Windows 路径输出
  APK_WIN="$(cd "$(dirname "$APK_PATH")" && pwd -W)/$(basename "$APK_PATH")"
  for S in $SERIALS; do
    echo "    安装到设备 $S ..."
    "$ADB" -s "$S" install -r "$APK_WIN"
  done
  echo "完成，手机应用列表打开 HermesChat 即可。"
fi
