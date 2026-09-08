#!/usr/bin/env bash
# build-macos.sh [--run] —— 在本机（macOS）构建 Mac 桌面安装包。
# 仅做：npm ci（依赖未变时跳过）→ vite 构建 dist-web → tsc 编译 desktop 主进程
# → electron-builder --mac（arm64 dmg + mac-arm64 目录内 .app 免安装版）。
# 与 build-windows.sh 同一策略：不含任何 git 同步。
#
# 用法：
#   scripts/build-macos.sh          # 构建
#   scripts/build-macos.sh --run    # 构建完直接打开免安装版（.app）
set -euo pipefail

RUN_AFTER_BUILD=0
if [ "${1:-}" = "--run" ]; then
  RUN_AFTER_BUILD=1
elif [ -n "${1:-}" ]; then
  echo "用法: $0 [--run]"; exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> [1/3] 检查 JS 依赖"
# npm ci 每次都会删掉整个 node_modules 重装，很慢。
# package.json / package-lock.json 都没比 node_modules/.package-lock.json 新，
# 说明依赖没变，直接跳过（与 build-windows.sh / build-android.sh 同一策略）。
if [ -f node_modules/.package-lock.json ] \
   && [ ! package-lock.json -nt node_modules/.package-lock.json ] \
   && [ ! package.json -nt node_modules/.package-lock.json ]; then
  echo "    依赖未变化，跳过 npm ci"
else
  npm ci --no-audit --no-fund --loglevel=error
fi

echo "==> [2/3] 构建（dist-web + desktop 主进程 + electron-builder --mac）"
npm run dist:mac

echo "==> [3/3] 产物"
DMG="$(ls -t dist-desktop/*.dmg 2>/dev/null | head -1 || true)"
# electron-builder 按架构命名输出目录：arm64 → mac-arm64，x64 → mac
UNPACKED_APP="dist-desktop/mac-arm64/HermesChat.app"
[ -d "$UNPACKED_APP" ] || UNPACKED_APP="dist-desktop/mac/HermesChat.app"
if [ -n "$DMG" ]; then
  ls -lh "$DMG"
  echo "安装包：$DMG（未签名，首次打开若被 Gatekeeper 拦截：右键 → 打开，或 xattr -cr dist-desktop）"
fi
if [ -d "$UNPACKED_APP" ]; then
  echo "免安装版：$UNPACKED_APP"
else
  echo "警告：未找到 HermesChat.app，检查上方构建日志"
fi

if [ "$RUN_AFTER_BUILD" = 1 ]; then
  if [ -d "$UNPACKED_APP" ]; then
    echo "==> 启动免安装版（open 启动，退出用 Cmd+Q 或关窗）"
    open "$UNPACKED_APP"
  else
    echo "无免安装版可启动"; exit 1
  fi
fi
