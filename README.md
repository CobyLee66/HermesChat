# HermesChat

**Hermes Agent 的远程客户端** —— Android / Windows / macOS / 浏览器四端同源。

在手机或桌面上连接电脑里运行的 [Hermes Agent](#1-准备-hermes-agent-服务端)，用聊天的方式使用你的 agent：多 profile、多会话、流式回复、思考过程、工具调用、审批与澄清交互、图片/文件/语音附件、定时任务管理。

- **一套代码四端跑** —— React Native（Android）+ react-native-web（浏览器）+ Electron（Windows / macOS），UI 与协议层完全共用，仅原生能力（SSH、语音、文件选择）按平台分叉。
- **自带 SSH 隧道** —— App 内置原生 SSH 模块，自动探测/拉起远端 `hermes serve`、建立本地端口转发、断线指数退避重连并 `session.resume` 恢复进行中的回合。不需要手动开隧道、不需要把服务暴露到公网。
- **协议零侵入** —— 只使用 Hermes 官方公开协议（WS JSON-RPC + REST），不修改服务端的任何源码、配置或数据。

---

## 功能特性

| 模块 | 能力 |
|---|---|
| 连接 | 多套连接配置（SSH 隧道 / 直连）卡片式管理，一键连接，可指定默认自动连接 |
| Profile | 头像 + 昵称 + 模型角标 + 状态点；昵称与头像可在 App 内编辑（`profiles.configure` / `profiles.set_asset`） |
| 会话 | 新建 / 恢复 / 重命名 / 删除 / 重开；按 profile 隔离；搜索、分类过滤（聊天 / 自动化 / 全部）、两档排序（最近消息 / 创建时间） |
| 聊天 | 流式文本、思考/推理过程（可折叠）、工具调用卡片（参数 + 结果 + diff 高亮）、错误信息、Markdown 渲染（含表格横向滚动） |
| 交互 | 权限审批卡片（once / session / always / deny 内联按钮）、clarify 澄清卡片（单选 / 多选 / 批量）、长回合中断 |
| 模型 | 底部弹出式模型选择器（`model.options` + `config.set`），顶栏实时显示模型 · 上下文用量 · 思考等级 |
| 附件 | 相册图片多选（自动压缩）、任意文件（`@file:` 引用）、语音录音 → STT 转写 |
| 检索 | 会话内「查找聊天记录」跳转 + 高亮；会话列表按标题/摘要搜索 |
| 定时任务 | 任务列表（状态徽章 / 中文计划描述 / 下次运行 / 错误明细）、暂停恢复、立即运行、运行历史、只读运行回放、六模式计划构建器（间隔 / 每天 / 每周 / 每月 / 一次性 / 自定义 cron） |
| 桌面增强 | 响应式三栏布局（窄 / 中 / 宽断点自适配）、系统文件对话框、粘贴与拖拽附件、失焦完成通知 |

---

## 架构

```
┌──────────── 客户端（本仓库）────────────┐                    ┌──── 你的电脑 ────┐
│  UI (RN / RNW / Electron)               │   SSH (22)         │  hermes serve    │
│    ↓                                    │  ═══════════════>  │  127.0.0.1:9119  │
│  Store (zustand) ──> RpcClient (JSON-RPC)│  内置隧道 127.0.0.1:L │  /api/ws         │
│    ↓                    ↑               │  自动重连 + resume  │  /api/**         │
│  SshManager ──> 原生 SSH 模块 / ssh2     │                    │                  │
└─────────────────────────────────────────┘                    └──────────────────┘
```

- **`src/ssh/`** —— 原生能力差异全部收敛在这里：`HermesSsh` 契约 + 各平台实现（Android Kotlin/JSch、桌面主进程 ssh2、浏览器直连），上层 `SshManager` 状态机（`disconnected → connecting → bootstrapping → tunneling → ready → reconnecting`）三端共用。
- **`src/rpc/`** —— JSON-RPC 请求/响应配对、事件按会话分发、消息聚合器（事件流 → 时间线 `TimelineItem[]`）、REST 封装（cron、运行历史）。
- **`src/panels/`** —— 手机屏幕与桌面列**同源**的面板组件（会话列表、时间线、输入区、弹层、流程函数），这是三端行为一致的关键。
- **`desktop/`** —— Electron 主进程：窗口、ssh2 隧道、回环代理（渲染层从 `127.0.0.1:<port>` 加载，天然同源，绕开 CORS 与 WS Host/Origin 防护）。

---

## 环境要求

**客户端**

- Node.js ≥ 22.11
- 浏览器端：任意现代 Chromium / Firefox
- Android：JDK 21 + Android SDK（compileSdk 37 / targetSdk 36、build-tools 37.0.0、NDK 27.1.12297006）
- iOS：暂未启用（工程目录保留，原生 SSH 模块待补）
- 桌面端：无需额外工具链（Electron 由 npm 安装，打包 Windows 包建议在 Windows 上执行）

**服务端**

- 电脑上已安装并运行 Hermes Agent，`hermes serve` / `hermes dashboard` 监听 `127.0.0.1:9119`（默认）

---

## 快速开始

### 1. 准备 Hermes Agent 服务端

在电脑上启动 Hermes 服务（默认监听 `127.0.0.1:9119`）：

```bash
hermes serve        # 或 hermes dashboard
```

App 连的是 `serve` / `dashboard` 的 FastAPI 服务（WS `/api/ws` + REST `/api/**`），**不是** `hermes gateway`（消息平台网关）。

### 2. 浏览器里先跑起来（最快）

```bash
npm install
npm run web         # vite dev server，默认 http://localhost:5188
```

打开页面后点连接主页的「**⚡ 浏览器直连（本机 127.0.0.1:9119）**」即可连上本机服务（vite 会把 `/api/**` 代理到 9119 并重写 Host/Origin，token 自动从 SPA HTML 提取）。

> 浏览器模式只能连**本机**的 gateway（代理指向 `127.0.0.1:9119`），且附件上传 / 语音 / SSH 隧道等依赖原生模块的功能不可用——它的定位是开发调试与 UI 预览。

### 3. Android

```bash
npm run android     # 需完整 RN 工具链（JDK 21 + Android SDK + NDK）
```

或只出 APK / 装到手机：

```bash
cd android && ./gradlew assembleRelease        # 产物 android/app/build/outputs/apk/release/
adb install -r app/build/outputs/apk/release/app-release.apk
```

`scripts/` 里另有几支便捷脚本（`build-android.sh`、`install-android.sh`、`device-log.sh`），以及面向「本机无 Android 工具链、借另一台机器构建」场景的 `build-android-remote.sh` / `build-desktop-remote.sh`——它们通过 SSH 驱动远端拉取代码并构建，远端主机名/路径可用环境变量覆盖（见脚本头部注释）。

### 4. 桌面端（Windows / macOS）

```bash
npm run desktop:dev     # 开发模式：构建 web 产物 + 编译主进程 + 启动 Electron
```

打包：

```bash
npm run dist:mac        # macOS dmg（arm64）
npm run dist:win        # Windows NSIS 安装包 + win-unpacked 免安装版
```

产物在 `dist-desktop/`。包未签名：Windows 首次运行需在 SmartScreen 选「仍要运行」，macOS 需右键 →「打开」。

---

## 连接配置

在连接主页点「+ 添加配置」，两种连接类型：

### SSH 隧道（推荐，适合手机）

| 字段 | 说明 |
|---|---|
| 主机 / 端口 | 运行 Hermes 的电脑，如 `192.168.1.10` / `22` |
| 用户名 | SSH 登录用户 |
| 认证 | 密码，或粘贴私钥 PEM（可带口令） |

App 会自动完成：探测远端是否已有 `hermes serve` → 没有则拉起 → 建立本地端口转发 → 连 WS。断线后指数退避重连（1s → 30s）并恢复会话。

**这是唯一能把手机安全接到远端服务的方式**——服务始终只监听远端 loopback，不暴露到公网。

### 直连（适合桌面端 / 局域网调试）

直接连一个已经在跑的 gateway（`host` + `port`）。Session Token 留空时会自动从 gateway 首页提取 `__HERMES_SESSION_TOKEN__`，也可以手动填。

- 桌面端：渲染层与 gateway 跨源，token 提取与请求转发放在 Electron 主进程（回环代理）完成。
- 浏览器：只能连本机 `127.0.0.1:9119`。
- 手机：需 gateway 监听非 loopback 地址（或先 `adb reverse tcp:9119 tcp:9119`）。

---

## 使用说明

1. **连接** —— 主页点配置卡片连接。想开机自动连，点卡片上的「自动连接」圆点（全局唯一，再点取消）。
2. **选 profile** —— Profile 列表显示全部 agent；点进某个 profile 看它的会话。点头像/昵称可改资料。
3. **会话** —— 右上角「新会话」开新对话；下拉刷新；工具栏一行两个下拉管**过滤**（聊天 / 自动化 / 全部）和**排序**（最近消息 / 创建时间）；「搜索」药丸按标题与摘要过滤；长按/右键会话行有重命名、删除、查找聊天记录。
4. **聊天** —— 底部输入框发送。流式回复中可上滑阅读历史（视口不会被流式内容拖走，滚回底部或发消息即恢复跟随）。顶栏显示「模型 · 上下文用量 · 思考等级」，点右上角 ⋯ 可切换模型、重命名、删除会话、查找聊天记录、隐藏工具与思考。
5. **交互应答** —— agent 请求权限或提出澄清问题时，会内联一张卡片，直接点按钮作答，不用手输指令。
6. **附件** —— 输入框「＋」可选图片（自动压缩后上传）、文件（以 `@file:` 引用插入）、语音（录音后走服务端 STT 转写为文本）。桌面端还支持直接粘贴图片、拖拽文件到窗口。
7. **复制 Markdown** —— 桌面/网页端拖动选中助手回复，`Cmd/Ctrl+C` 得到的是 **Markdown 源码**而不是渲染后的纯文本；右键气泡另有「复制 Markdown / 复制纯文本」。
8. **定时任务** —— 主页左上角切到「定时任务」：浏览任务、暂停/恢复、立即运行、编辑、看运行历史；点运行记录进只读回放页（元信息 + 对话回放），也可「在聊天中打开」。

**桌面快捷键**：`Enter` 发送 / `Shift+Enter` 换行、`Ctrl+N` 新会话、`Esc` 关闭弹层。

---

## 开发

### 常用命令

```bash
npx tsc --noEmit            # 类型检查
npm run lint                # eslint
npm test                    # jest 单测
npm run web                 # 浏览器调试（热更新）
npm run web:build           # 构建 web 产物到 dist-web/
npm run desktop:build       # 编译 Electron 主进程
node scripts/harness.mjs    # 端到端跑本机 127.0.0.1:9119（会发一次真实 prompt）
```

### 目录结构

```
src/
  screens/      手机导航栈屏幕（连接 / Profile / 会话 / 聊天 / 定时任务）
  panels/       手机与桌面共用面板（会话列表、时间线、输入区、弹层、流程）
  desktop/      Electron 渲染层壳（响应式三栏）
  components/   UI 组件（气泡、头像、Markdown、工具卡、思考块、审批/澄清卡…）
  rpc/          JSON-RPC 客户端、事件聚合器、REST 封装、类型
  ssh/          原生能力契约与各平台实现、隧道状态机
  store/        zustand 状态（connection / chat / sessions / profiles / cron）
  utils/        纯函数（滚动跟随、搜索、排序、校验、Markdown 源码映射…）
  web-stubs/    浏览器端原生模块打桩
desktop/        Electron 主进程 + preload + 打包配置
scripts/        构建、安装、冒烟脚本
__tests__/      jest 用例
docs/           设计、协议、原生模块契约
```

### 冒烟测试

`scripts/` 下有基于 Playwright 的端到端冒烟脚本（`web-*-smoke.js` / `desktop-*-smoke.js`），配合 `scripts/mock-gateway.js`（本地假 gateway，覆盖流式回包、会话、cron REST 等）可在**不接触真实服务**的前提下验证 UI 行为：

```bash
node scripts/web-scroll-follow-smoke.js    # 自起 mock + build + preview，全自动
```

### 代码约定

- UI 文案与代码注释用中文。
- zustand 选择器必须返回稳定引用（禁止 `?? []` 之类内联新对象）。
- 原生能力差异一律收敛在 `src/ssh/`，UI 与协议层保持平台无关。

---

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/plan.md`](docs/plan.md) | 总体设计方案（目标、范围、架构、里程碑） |
| [`docs/protocol.md`](docs/protocol.md) | WS JSON-RPC + REST 协议细节与实测结论 |
| [`docs/ssh-module.md`](docs/ssh-module.md) | 原生 SSH 模块契约 |
| [`docs/desktop.md`](docs/desktop.md) | 桌面端与 Web 版统一方案 |
| [`DECISIONS.md`](DECISIONS.md) | 架构与技术选型决策记录 |
| [`PROGRESS.md`](PROGRESS.md) | 开发进度与踩坑记录 |

---

## 许可

本项目采用 **[PolyForm Noncommercial License 1.0.0](LICENSE)**（源码公开，非 OSI 开源许可）。

**你可以免费做的事**：个人学习、研究、试验、业余项目、私人娱乐等一切**非商业目的**的使用、修改与分发；慈善机构、教育机构、公共科研机构、公共安全/卫生机构、环保组织与政府机构的使用同样免费，不论其资金来源。

**需要额外授权的事**：任何**商业目的**的使用——包括在公司业务中使用、集成进商业产品或服务、对外提供有偿服务等。这类使用需要单独获得商业许可，请通过 Issue 或邮件联系作者。

> 简要说明：PolyForm Noncommercial 不是 OSI 认可的开源许可证，因此本项目的准确说法是「**源码公开、非商业免费**」（source-available）而非严格意义的「开源」。如果你的场景需要 OSI 认可的开源许可，请先与作者联系。

完整条款以 [`LICENSE`](LICENSE) 为准。

### 第三方组件

本项目依赖的库均为宽松许可（MIT / Apache-2.0），与本项目的许可不冲突。界面图标来自 [Tabler Icons](https://github.com/tabler/tabler-icons)（MIT）。

### 免责声明

HermesChat 是**非官方**第三方客户端，与 Hermes Agent 上游项目及其作者无隶属或背书关系。「Hermes」相关名称与标识归其各自权利人所有。本软件按「原样」提供，不附带任何担保；使用前请自行评估风险，尤其是 SSH 凭据与远端主机访问权限的管理。

