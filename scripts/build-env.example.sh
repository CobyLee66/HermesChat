#!/usr/bin/env bash
# build-env.example.sh —— 本机构建环境的**模板**（此文件入库，供他人参考）。
#
# 用法：复制为 scripts/build-env.sh（该文件已 gitignore，不入库）后按自己的环境填写。
#       scripts/*.sh 会在启动时自动 source 它；也可以用环境变量临时覆盖。
#
#   cp scripts/build-env.example.sh scripts/build-env.sh
#
# ⚠ 本机专属信息（主机名、用户名、内网地址、设备序列号等）只允许写在这里，
#   不要写进脚本本体或任何文档。

# ── 远端构建机（本机没有 Android/Windows 工具链时，借另一台机器构建）──────────
# 在 ~/.ssh/config 里给构建机配一个别名，这里填别名即可（不要填内网 IP）
export BUILD_HOST="buildhost"

# 构建机上本工程的目录（cmd 风格反斜杠；另需一份正斜杠形式给 scp 用）
export BUILD_DIR='C:\HermesChat'
export BUILD_DIR_FWD='C:/HermesChat'

# 构建机上 Git for Windows 自带的 bash（远端 cmd 里 bash 不一定在 PATH）
export BUILD_BASH='C:\Program Files\Git\bin\bash.exe'

# 构建机上 adb 的路径（远端 Windows 路径；本机 PATH 里有 adb 时可不填）
export BUILD_ADB='C:\Softwares\Android\platform-tools\adb.exe'
# 同上，Git Bash 风格路径（供本机构建脚本回退查找）
export BUILD_ADB_POSIX='/c/Softwares/Android/platform-tools/adb.exe'

# 推送临时文件（APK）到构建机的落点。默认用 Windows 公共目录，避免暴露用户名。
export BUILD_TMP_DIR='C:/Users/Public'
export BUILD_TMP_DIR_WIN='C:\Users\Public'

# 手机序列号（adb -s 用）。留空则 adb 在单设备时自动选择；
# 也可以用标准环境变量 ANDROID_SERIAL 临时指定。
export ANDROID_SERIAL=""

# ── 本地验证用服务端（可选）────────────────────────────────────────────────
# 端到端打真实 gateway 时用；文档里一律写占位符，不要写真实地址。
# export HERMES_SERVER="127.0.0.1:9119"
