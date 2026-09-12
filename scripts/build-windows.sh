#!/usr/bin/env bash
# build-windows.sh [--run] —— 在构建机（Windows，Git Bash）本地构建 Windows 安装包。
# 仅做：npm ci（依赖未变时跳过）→ vite 构建 dist-web → tsc 编译 desktop 主进程
# → electron-builder --win（NSIS 安装包 + win-unpacked 免安装版）。
# 不含任何 git 同步：构建副本的代码更新由 build-desktop-remote.sh 推送或手动 git pull。
#
# 用法：
#   scripts/build-windows.sh          # 构建
#   scripts/build-windows.sh --run    # 构建完直接启动免安装版（win-unpacked）
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
# 说明依赖没变，直接跳过（与 build-android.sh 同一策略）。
if [ -f node_modules/.package-lock.json ] \
   && [ ! package-lock.json -nt node_modules/.package-lock.json ] \
   && [ ! package.json -nt node_modules/.package-lock.json ]; then
  echo "    依赖未变化，跳过 npm ci"
else
  npm ci --no-audit --no-fund --loglevel=error
fi

echo "==> [2/3] 构建（dist-web + desktop 主进程 + electron-builder --win）"
npm run dist:win

echo "==> [3/3] 产物"
SETUP_EXE="$(ls -t dist-desktop/*.exe 2>/dev/null | head -1 || true)"
UNPACKED_EXE="dist-desktop/win-unpacked/HermesChat.exe"
if [ -n "$SETUP_EXE" ]; then
  ls -lh "$SETUP_EXE"
  echo "安装包：${SETUP_EXE}（未签名，首次运行 SmartScreen 选「仍要运行」）"
fi
if [ -f "$UNPACKED_EXE" ]; then
  echo "免安装版：$UNPACKED_EXE"
else
  echo "警告：未找到 win-unpacked/HermesChat.exe，检查上方构建日志"
fi

if [ "$RUN_AFTER_BUILD" = 1 ]; then
  if [ -f "$UNPACKED_EXE" ]; then
    echo "==> 启动免安装版（关窗即退出）"
    "./$UNPACKED_EXE"
  else
    echo "无免安装版可启动"; exit 1
  fi
fi
