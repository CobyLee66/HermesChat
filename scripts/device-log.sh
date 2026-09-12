#!/usr/bin/env bash
# device-log.sh [dump|watch|clear]   —— 经构建机的 adb 抓 HermesChat 的手机日志
#   dump : 抓当前日志缓冲并过滤 App 相关行（默认）
#   watch: 实时跟踪（Ctrl+C 停止）
#   clear: 清空日志缓冲（复现前先清一下再看最干净）
#
# ⚠ 构建机主机名、adb 路径等本机信息不入库：复制 scripts/build-env.example.sh
#   为 scripts/build-env.sh 并填写（已 gitignore）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/build-env.sh" ] && . "$SCRIPT_DIR/build-env.sh"

MODE="${1:-dump}"
REMOTE_HOST="${BUILD_HOST:-buildhost}"
ADB="${BUILD_ADB:-adb}"
SERIAL="${ANDROID_SERIAL:-}"
SEL=""
[ -n "$SERIAL" ] && SEL="-s $SERIAL"
FILTER='HermesSsh|HermesSsh-Jsch|ReactNativeJS'

case "$MODE" in
  dump)
    ssh "$REMOTE_HOST" "$ADB $SEL logcat -d -v threadtime" | grep -E "$FILTER" | tail -200
    ;;
  watch)
    ssh "$REMOTE_HOST" "$ADB $SEL logcat -v threadtime HermesSsh:V HermesSsh-Jsch:V ReactNativeJS:V *:S"
    ;;
  clear)
    ssh "$REMOTE_HOST" "$ADB $SEL logcat -c"
    echo "已清空手机日志缓冲"
    ;;
  *) echo "用法: $0 [dump|watch|clear]"; exit 1 ;;
esac
