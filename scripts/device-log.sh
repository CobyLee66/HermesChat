#!/usr/bin/env bash
# device-log.sh [dump|watch|clear]   —— 通过 构建机 adb 抓 HermesChat 的手机日志
#   dump : 抓当前日志缓冲并过滤 App 相关行（默认）
#   watch: 实时跟踪（Ctrl+C 停止）
#   clear: 清空日志缓冲（复现前先清一下再看最干净）
set -euo pipefail

MODE="${1:-dump}"
REMOTE_HOST="构建机"
ADB='C:\Softwares\Android\platform-tools\adb.exe'
FILTER='HermesSsh|HermesSsh-Jsch|ReactNativeJS'

case "$MODE" in
  dump)
    ssh "$REMOTE_HOST" "$ADB logcat -d -v threadtime" | grep -E "$FILTER" | tail -200
    ;;
  watch)
    ssh "$REMOTE_HOST" "$ADB logcat -v threadtime HermesSsh:V HermesSsh-Jsch:V ReactNativeJS:V *:S"
    ;;
  clear)
    ssh "$REMOTE_HOST" "$ADB logcat -c"
    echo "已清空手机日志缓冲"
    ;;
  *) echo "用法: $0 [dump|watch|clear]"; exit 1 ;;
esac
