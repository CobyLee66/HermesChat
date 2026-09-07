# 桌面端（Windows/macOS）与 Web 版统一设计方案

> 状态：**M0~M5 已实现（2026-09-06，桌面 v0.1）**，见 §8 实现记录；§1~7 为原设计，方向未变，差异处已在 §8 标注。相关：docs/plan.md（总体）、docs/protocol.md（协议）、docs/ssh-module.md（Android 隧道）。

## 8. 实现记录（2026-09-06）

### 8.1 架构落地

- **壳**：`desktop/main.ts`（Electron 主进程）+ `desktop/preload.ts`（contextBridge → `window.hermesDesktop`），tsconfig 独立（`desktop/tsconfig.json`，nodeNext），`npm run desktop:build` 编译到 `desktop/dist/`。
- **SSH 隧道**：主进程 ssh2 实现 HermesSsh 契约（docs/ssh-module.md §2/§6 全语义对齐：错误码 E_*、keepalive 15s×3、exec 8MiB 上限、stopCommand/closeLocalForward/disconnect 幂等、被杀 task exit=-1 恰好一次、HostKey accept-new 持久化 `userData/known-hosts.json`）。渲染层 `src/ssh/desktopHermesSsh.ts` 是桥的 typed wrapper，**vite alias 把 `./HermesSsh` 指到它**（替代原 web-stubs/HermesSsh.ts），因此 `SshTunnelTransport`/`SshManager` 的 bootstrap 与重连逻辑单源复用，零改动（`isAvailable=true` 时 execRemote 自动启用，multiplex/foreign 只读链路可用）。
- **回环代理（关键差异）**：渲染层从 `http://127.0.0.1:<port>` 加载（主进程 HTTP+WS 服务），同源无 CORS；`/api/**`（含 /api/ws upgrade）反代到**代理上游**，Host/Origin 重写策略 = vite.config.ts 已验证方案。端口跨次启动稳定（`userData/proxy-port.json` 记忆，51899 起顺延）——**端口变 = localStorage origin 变 = 配置丢失**，故必须记忆复用。`src/ssh/desktopBridge.ts` 的 `DesktopSshTransport` 只做一件事：隧道 connect 后把 wsUrl/httpUrl 改写为同源相对地址。
- **代理上游（2026-09-08 直连模式泛化）**：主进程 `proxyUpstream: {host, port} | null` 单槽位，同一时刻只有一条连接。SSH 隧道 = `openLocalForward` 登记隧道本地端口（`127.0.0.1:<localPort>`）；直连配置 = 新 IPC `desktop:directConnect {host, port, token?}` 登记 gateway 地址本身，token 手动优先、否则主进程 GET 首页代提 `__HERMES_SESSION_TOKEN__`（渲染层与 gateway 跨源，fetch 不可靠），`desktop:directDisconnect` 清空；上游未建立时 /api 返回 503。渲染层变体 `DesktopDirectTransport`（同在 desktopBridge.ts）拿到 token 后同样改写为同源相对地址。
- **引擎选择**：`App.tsx` → `Platform.OS==='web'` 时 `hasDesktopBridge() ? initDesktopEngine() : initWebDirectEngine()`。桌面隐藏「浏览器直连」入口（直连场景已由「直连」配置类型覆盖）。

### 8.2 响应式布局（宽度驱动，与是否 Electron 无关）

- 断点 `src/ui/breakpoints.ts`：narrow <900（单列）/ medium 900–1279（两栏）/ wide ≥1280（三栏）。手机恒为 narrow 且走原导航栈，零影响；浏览器拉宽即可预览桌面布局（`npm run web` 调试闭环）。
- 壳 `src/desktop/DesktopApp.tsx`：web 构建连接 ready 后替换 `Stack.Navigator`；断线卸载回导航栈连接页。三栏 = `ProfileRail`（64px 竖条）+ `SessionColumn`（300px）+ `ChatPane`；medium 会话列 + 聊天区；narrow 单列 Profile 列表 → 会话列 → 聊天。三种断点的会话列头统一带「‹ 返回」按钮（2026-09-07）回 Profile 选择首屏（替代早期的 medium/narrow profile 下拉切换器）；wide 的竖条保留做快速切换。选中态在 `desktopUiStore`。
- **共享面板**（`src/panels/`，手机屏幕与桌面列同源）：`SessionListPanel`（过滤+列表+会话行右键挂点）、`TimelineView`（时间线+滚动条+斜杠浮层挂点，消息列不限宽通栏）、`ChatInputBar`（输入区，`pickers` 注入附件来源、`enterToSend`）、`ChatOverlays`（菜单/模型/信息弹层）、`useChatComposer`（输入+斜杠+发送分流）、`sessionFlows`（打开/新建/删除会话流程）。ChatScreen/SessionListScreen 已改为薄壳，行为保持。
- `utils/alert.ts`：桌面走自绘 `ConfirmDialogHost`（`src/ui/dialogStore.ts` 排队），修掉 RNW 下 Alert 无 UI 的老问题；普通浏览器 window.confirm 兜底；原生不变。

### 8.3 桌面能力

| 能力 | 实现 |
|---|---|
| 附件选文件 | IPC `desktop:pickFiles`（主进程 dialog）→ `desktop:readFileDataUrl`（主进程 fs）→ data URL；压缩在渲染层 canvas（`utils/media.ts` web 分支，替代 image-resizer）；文本文件（SSH 私钥 PEM）走 `desktopPickTextFile`（readFileText utf8） |
| 粘贴/拖拽 | ChatPane window 级 paste/drop 监听：图片 → 待发附件；文件 → `@file:` 引用 |
| 语音 | `VoiceButton.web.tsx` 桌面分支：getUserMedia + MediaRecorder（mp4/aac 优先，webm/opus 兜底）→ 转写链路复用；普通浏览器仍是禁用占位 |
| 头像 | ProfileEditScreen 桌面分支：desktopPickImages + canvas cover 512 |
| 头像缓存 | `avatarCache` web 分支：data URL → Blob → `blob:` object URL（按 profile 名进程内记忆化，改头像先撤销再重建）；`Avatar` 对 `blob:` 与原生 `file://` 同语义挂载即显——切 profile / 切过滤档的行重挂载不再重播渐现（2026-09-07，D027；冷启动首拉仍渐现属真实加载） |
| 失焦通知 | `useCompleteNotifications`（busy 翻转 + document.hidden）→ IPC `desktop:notify` → 主进程 Notification，点击聚焦窗口 |
| 交互 | Enter 发送/Shift+Enter 换行（IME 保护）、Esc 关弹层、Ctrl+N 新会话、消息列通栏（2026-09-07 取消 760px 限宽）、会话行右键菜单（复制标题/删除，2026-09-07；⚠ React `onContextMenu` 委托在 RNW 下实测不派发，走行宿主节点原生 `addEventListener`）、ModelPicker web 居中对话框 |
| 菜单 | Windows/Linux 不设菜单栏（`Menu.setApplicationMenu(null)`，默认菜单只有通用项无价值；文本复制粘贴由 Chromium 原生处理）；macOS 保留最小中文菜单（应用/编辑/视图/窗口——mac 编辑菜单承担 Cmd+C/V 快捷键）。**后续加菜单必须用中文标签** |

### 8.4 打包

- `electron-builder.yml`：appId `com.hermeschat.desktop`；打包内容 = `desktop/dist` + `desktop/resources` + `dist-web` + 生产 node_modules（asarUnpack ssh2）；产物 `dist-desktop/`。**应用图标与移动端同款**：`desktop/resources/icon.png`（512×512 原图），builder 自动转 ico/icns（验证：mac 包内 icon.icns 与 Windows exe 均已生效）；BrowserWindow 另设 icon 供开发模式窗口/任务栏用。未签名（Windows 首次运行 SmartScreen 选「仍要运行」）。
- `npm run dist:mac`（本机验证通过，arm64 dmg）；**Windows 包**：`scripts/build-desktop-remote.sh`（推 GitHub → 构建机 拉取 → `scripts/build-windows.sh` → 取回 exe），构建机 不手改。Android 构建脚本已加 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`（出 APK 不用下 Electron 二进制）。
- 端口/窗口状态/known_hosts 均存 `userData`（`~/Library/Application Support/HermesChat` / `%APPDATA%/HermesChat`）。

### 8.5 已知边界（后续迭代）

- 悬停（hover）态、图片点击灯箱未做；助手消息 web 侧已随 markdown-it HTML 原生可选中，用户消息选中/复制待统一。会话行右键菜单已做（复制标题/删除），profile 行/聊天气泡区右键未做。
- 语音 webm/opus 是否被服务端 faster-whisper 正常转写待真机验证（mp4/aac 已优先选用）。
- 未做：深色模式、托盘、自动更新、safeStorage 加密私钥（私钥仍 localStorage 明文，与手机版策略一致）。
- 真实 SSH 隧道 GUI 全流程（填配置→连接→聊天）待用户在 Electron/Windows 包验收；自动化验证只覆盖壳启动与代理（不碰 live 服务写操作）。

### 8.6 诊断日志（2026-09-07，白屏排查取证）

为定位「Windows 端窗口后台（最小化/遮挡）几分钟后整窗空白」加装，**零行为变化**（未动 backgroundThrottling、无自愈 reload，定因后再针对性修）。

- **文件**：`userData/logs/main.log`（Windows `%APPDATA%\HermesChat\logs\main.log`，macOS `~/Library/Application Support/HermesChat/logs/main.log`），本地时间戳 + 级别，超 1MB 轮转 `.old`。渲染层经 IPC `desktop:log`（preload `log()`）汇入**同一文件**，主/渲染层时间线统一。
- **主进程埋点**（`desktop/main.ts`）：启动版本/代理端口、窗口 minimize/restore/show/hide/focus/blur、`render-process-gone`、`unresponsive/responsive`、`did-fail-load`/`did-finish-load`（页面是否被重载）、`child-process-gone`（GPU/Utility 全记）、SSH connect 成败/意外断连/forward 开关、代理 WS upgrade 与 /api 非 2xx（静态请求不记）。
- **渲染层埋点**：`src/utils/webDiagnostics.ts`（仅 Electron 生效，浏览器零开销）——全局 `error`/`unhandledrejection`、`visibilitychange`、30s 心跳（state/vis/focus/ws/JS 堆）；`src/store/connection.ts` 连接状态机迁移（开始连接/就绪/断开原因/重连尝试/回前台重试）；`src/components/ErrorBoundary.tsx`（web 入口包裹 App）把 render 异常从「静默白屏」变成可见错误 + 日志。
- **四类根因的日志指纹（互斥）**：
  | 候选根因 | 指纹 |
  |---|---|
  | 渲染/GPU 进程死亡 | `render-process-gone` / `child-process-gone`（reason: crashed/oom/killed） |
  | React render 异常卸载整树 | ErrorBoundary 上报堆栈；复现时窗口显示错误摘要而非纯空白 |
  | JS 活着但不重绘（节流/合成器） | 无崩溃事件 + 心跳持续（心跳间隔被拉长 = 节流证据） |
  | 连接断开 | SSH 意外断连 / `ws closed code=` / 代理 5xx 与空白时刻的时间线对齐（注：纯断连应显示橙色重连横幅 + 内容保留，与「整窗空白」不符） |

### 8.7 常驻与探活（2026-09-07，D028，Mac 日志定因后修复）

**定因**（Mac 挂机日志）：macOS App Nap 把整个 app（主进程+渲染层）反复冻结——心跳间隔从 30s 被拉到 16~34 分钟；冻结期间远端周期性掐断 WS（`code=1006`，约 16~69 分钟一次），重连机制本身每次都能 2s 内恢复，但若连接死在冻结窗口内则本地全程无感知。回前台时 state 仍是 `ready`（假活），点击的 RPC 掉进死管道等 30s 超时——表现为「点不动、不刷新、无断线横幅」。

**修复**（三层，全部对 Windows 同样生效）：
1. **禁系统挂起**：主进程 `powerSaveBlocker.start('prevent-app-suspension')`（app 生命周期常开，启动时写日志）——SSH keepalive、重连退避、探活定时器在后台不再被冻结；接受挂机期额外耗电（常驻聊天客户端 + 后台回复通知的既定定位）。
2. **禁渲染层节流**：`webPreferences.backgroundThrottling: false`——Chromium 层的 timer 节流/遮挡降级全部关闭。
3. **应用层探活**（`src/store/connection.ts`）：`/api/health` 走与 WS 相同的隧道（复用 bootstrap 已验证端点，不要求服务端加 ping 帧）；回前台（AppState→active，三端引擎共用 `handleForeground`）且 ready 时必探（10s 超时），失败立即触发断线重连；ready 态周期探活每 30s 一次，**连续 2 次**失败才判死（单次抖动不误杀），reconnecting 期间不探（退避重连本身就是探测）。移动端原生同样生效（同一段 store 代码）。

验证：jest 172 用例（含探活两连失败判死、回前台探活触发重连两用例）；Mac 冒烟确认 blocker 启动、心跳/探活无异常。Windows「整窗空白」是另一条路径（渲染层嫌疑），仍待 Windows 端日志按 §8.6 指纹定位。

### 8.8 助手消息复制 Markdown 源码（2026-09-08，D030）

桌面/web 端助手气泡的复制**不走**手机端的长按弹窗（`ChatPane` 不传 `onSelectText` 是刻意设计），而是双入口（`src/components/MarkdownText.web.tsx`，浏览器与 Electron 共用）：

1. **拖选即源码**：拖选气泡内渲染文本 → Cmd/Ctrl+C → 剪贴板得到所选范围的 Markdown 源码。实现：markdown-it 块级 token 的 `map`（文档级源行号）注入 `data-md-map` 属性（`src/utils/mdSourceMap.ts`），document 级单例 `copy` 监听（copy 事件派发到 activeElement 不冒泡经气泡容器，必须注册表模式）按「选区覆盖块的行范围并集」切源码替换剪贴板。**粒度是块级**（不会复制出半截表格/列表）；跨消息选择/输入框等可编辑元素不干预（浏览器默认行为）。**前提：web 端 assistant 气泡不包 TouchableOpacity**（`Bubble.tsx` 的 `Platform.OS === 'web'` 分支）——RNW 可点击容器渲染 `cursor:pointer` 且阻止 mousedown 启动文字选择（Windows 实测拖不出选区后修复）；真实拖选路径必须用真实鼠标事件测试，程序化 Selection API 会绕过该层。
2. **右键菜单**：气泡右键 →「复制 Markdown」（整条源码）/「复制纯文本」（渲染后文本）。原生 `contextmenu` 监听（React 合成事件不派发，§见 SessionListPanel 先例），`navigator.clipboard.writeText`。

**剪贴板权限（存量 bug 修复）**：`desktop/main.ts` 的 `setPermissionRequestHandler` 原本只放行 `media`，renderer 的 `navigator.clipboard.writeText` 被全拒——右键「复制会话标题」在 Electron 桌面一直静默失败（catch 吞掉）。现放行 `clipboard-read` / `clipboard-sanitized-write`，其余权限策略不变。

验证：jest 196（mdSourceMap 12 例）；web + 真实 Electron 直连 live 9119 只读实测（拖选标题块得 `## …` 源码、**真实鼠标拖选** 5 字 → Cmd+C 得 `## 📦 清理结果`、全选拖选 ≡ 右键整条源码 914 字交叉验证、纯文本无 # 语法、输入框复制不受拦截），脚本 `scripts/web-md-copy-smoke.js`、`scripts/desktop-md-copy-smoke.js`。手机端等价能力：长按弹层加「复制全部」按钮（`clipboard.ts`/`clipboard.native.ts` 平台变体，RN 0.87 核心已无 Clipboard，用 `@react-native-clipboard/clipboard`），真机已验证。

## （以下为原设计文档）

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
