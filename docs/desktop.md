# 桌面端（Windows/macOS）与 Web 版统一设计方案

> 状态：设计方案（尚未实现）。相关：docs/plan.md（总体）、docs/protocol.md（协议）、docs/ssh-module.md（Android 隧道）。

## 1. 核心判断

本项目已具备一个关键架构优势：**UI 与协议层完全平台无关**，平台差异全部收敛在 Transport/原生能力一层：

| 层 | 复用度 |
|---|---|
| 全部 UI（连接/会话/聊天/审批/模型切换） | 100%（react-native-web 已验证可跑） |
| RPC 客户端、聚合器、stores | 100%（无平台 API） |
| SSH 隧道 | **每平台一个实现**（Android=JSch 原生模块；桌面=Node ssh2；浏览器=不支持，直连兜底） |

所以桌面端 ≠ 重写，而是：同一份 `src/` UI + 一个新的 SSH 传输实现 + 一个壳。

## 2. 目标矩阵（一份代码，四个出口）

| 出口 | 技术 | SSH 隧道 | 用途 |
|---|---|---|---|
| Android APK | RN 原生（现状） | HermesSsh（Kotlin/JSch） | 正式手机端 |
| iOS（以后） | RN 原生 | SwiftNIO SSH 原生模块 | 正式手机端 |
| **Web 预览** | vite + react-native-web（现状 `npm run web`） | 无（vite 代理直连本机） | 日常 UI 迭代调试 |
| **桌面**（Win/macOS） | **Electron 壳 + 同一份 web 构建产物** | **Electron 主进程里的 Node ssh2** | 正式桌面端 |

## 3. 桌面端架构

```
┌─────────────── Electron ───────────────┐         SSH          ┌─ 远端 ─┐
│ Renderer: 现有 web 构建（RNW）          │                     │ hermes │
│   └─ DesktopSshTransport               │                     │ serve  │
│        │ contextBridge IPC              │  ════════════════>  │        │
│ Main: ssh2（连接/exec/起服/端口转发）    │                     │        │
│        + 本地回环代理（重写 Origin/Host） │                     │        │
└─────────────────────────────────────────┘                     └────────┘
```

- **壳选 Electron 而非 Tauri**：主进程就是 Node，ssh2 直接可用，和官方 hermes desktop（apps/desktop）同路线；electron-builder 打包 Windows/macOS 都不需要原生编译链（构建机 出 Windows 包，MacBook 本机出 macOS 包，均无需 Xcode/VS）。
- **SSH 用 `ssh2`（纯 JS）而不是系统 ssh**：连接参数（密码/私钥）与手机端同一套存储/表单；不依赖宿主是否装 OpenSSH；`ssh2` 的 `forwardOut` + 本地 `net.createServer` 即实现 `ssh -L`。备选：spawn 系统 `ssh -N -L`（官方 desktop 的做法，实现更简单但进程管理和错误处理更脏）。
- **DesktopSshTransport**：实现与 Android 版完全相同的 `HermesSsh` 方法面（connect/exec/startCommand/stopCommand/openLocalForward/closeLocalForward/disconnect + onDisconnect/onStdout/onExit 事件），通过 Electron preload 的 contextBridge 暴露为 `window.hermesDesktop`。`Platform.OS==='web'` 且 `window.hermesDesktop` 存在 → 走桌面 SSH；否则 → 现有浏览器直连。SshManager 的 transportFactory 已经预留了这个注入点。
- **Origin/Host 防护**：桌面渲染层从 `file://` 或本地回环加载。为与浏览器路径行为一致，主进程内嵌一个回环 HTTP/WS 代理（复用 vite.config.ts 里已验证的 Host/Origin 重写策略），渲染层永远连 `127.0.0.1:<代理端口>`。

## 4. 工程结构（新增部分）

```
desktop/
  main.ts           # Electron 主进程：窗口、ssh2 隧道、回环代理、IPC
  preload.ts        # contextBridge → window.hermesDesktop
  electron-builder.yml
src/ssh/desktopBridge.ts   # window.hermesDesktop → HermesSsh 同构 API（web 构建时按条件启用）
scripts/build-desktop.sh   # 构建机: 出 Windows 包；本机: 出 macOS 包
```

vite 构建一次产出 `dist-web/`，Android（Metro）、web 预览（vite dev）、桌面（Electron 加载 dist-web）共用同一份源码，CI 式脚本串行验证 tsc/jest。

## 5. 能力差异与降级策略

| 能力 | Android | 桌面 | Web 预览 |
|---|---|---|---|
| SSH 隧道 | ✓ | ✓（ssh2） | ✗（直连本机） |
| 图片/文件附件 | ✓ | ✓（系统文件对话框，Electron dialog API） | 打桩禁用 |
| 语音输入 | ✓（HermesAudio） | ✓（Electron 有 getUserMedia/MediaRecorder，浏览器 API 直录，无需原生模块） | 打桩禁用 |
| 头像上传 | ✓ | ✓ | 打桩禁用 |

桌面端语音反而比手机简单：MediaRecorder 是浏览器标准 API，Electron 渲染层直接用，无需 HermesAudio。

## 6. 实施步骤（建议顺序）

1. `desktop/` 壳 + ssh2 传输 + IPC 桥（最大不确定性在 ssh2 转发细节，先打通）。
2. `src/ssh/desktopBridge.ts` 接入 SshManager 的 transportFactory；web 构建按 `window.hermesDesktop` 探测。
3. electron-builder 构建机 出 Windows 包验证；MacBook 本机出 macOS 包（`npm run dist:mac`，无需 Xcode）。
4. 桌面专属打磨：窗口尺寸/菜单栏/托盘、附件系统对话框、语音 MediaRecorder 接入。
5. （更后）iOS：SwiftNIO SSH 模块补齐第四出口。

## 7. 风险

- ssh2 的 forwardOut 长连接保活/重连语义需要与 JSch 版对齐验证（keepalive、断线事件）——SshManager 的重连状态机不变，只换底层事件源。
- Electron 包体积（~80MB）——工具类应用可接受。
- 私钥存储：桌面端沿用"配置文件沙盒内明文"策略，或后续接入系统 keychain（Electron safeStorage API，顺手可做）。
