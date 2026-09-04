# DECISIONS.md — 决策日志

> 记录影响架构、技术选型、设计取舍的关键决策。只记「为什么」，不复述「是什么」（实现细节在 docs/ 与代码里）。
> 维护规则（记录时机/格式/修订与归档）见 AGENTS.md「Decision Recording」段；引用 `D0XX` 编号即可定位。

---

## 活跃决策

| ID | 决策 | 不可让步 | 日期 |
|----|------|---------|------|
| D001 | React Native + TypeScript 技术栈（Android 优先，iOS 后续），对齐 web dashboard 的对话体验；本机只做 JS/TS 开发 | UI/协议层保持平台无关（桌面端复用的前提） | 2026-09-01 |
| D002 | 本机（MacBook）不装 Android/iOS 工具链；APK 构建在 构建机，经 GitHub 同步（推 GitHub → 构建机 拉取构建 → 取回 dist/） | Mac 上仅 tsc/lint/jest/web 静态验证；构建机 的 `C:\HermesMobile` 是构建副本，禁止手改 | 2026-09-01 |
| D003 | 适配官方版 hermes 公开协议（WS JSON-RPC + REST），绝不修改服务端源码/配置/数据 | 遇「不改服务端实现不了」时停下来交用户决策，禁止擅自打补丁；对 live 服务禁写（除非用户批准当次验证） | 2026-09-01 |
| D004 | 自研 SSH 隧道原生模块 HermesSsh（Android = Kotlin + JSch），否决 `@dylankenneally/react-native-ssh-sftp` | 必须有端口转发 API（该库没有）；iOS 侧不依赖其 NMSSH 实现（模拟器不支持） | 2026-09-01 |
| D005 | 原生能力差异全部收敛在 `src/ssh/`（HermesSsh/HermesAudio 契约 + 各平台实现） | UI/协议层禁止 import 平台 API（`docs/desktop.md` 桌面端方案依赖此边界） | 2026-09-01 |
| D006 | LAN 场景走明文 HTTP/WS（SSH 隧道 / 局域网直连），release 放行 cleartext | `usesCleartextTraffic=true` 必须硬编码进 AndroidManifest——manifestPlaceholders 会被 RN gradle 插件 afterEvaluate 覆盖回 false | 2026-09-01/02 |
| D007 | Android ed25519 签名打包 bcprov（bouncycastle） | JSch 的 `jce.SignatureEd25519` 需 Java15+，Android 不可用；不得换成精简依赖 | 2026-09-02 |
| D008 | 远端 hermes 启动路径运行时探测绝对路径（`command -v` → zsh/bash 登录 shell → `~/.local/bin` 等常见目录） | 不得直接用裸 `hermes` 命令——非交互 SSH 无用户 PATH | 2026-09-02 |
| D009 | zustand 选择器必须返回稳定引用 | 禁止 `?? []` 内联新对象——useSyncExternalStore 视为持续变化，Maximum update depth exceeded 闪退；缺省用模块级常量 | 2026-09-02 |
| D010 | SSH 连接 profile 化（多配置卡片 + 自动连接开关 + 全字段持久化 `hermes.connections.v2`），删除直连模式 | DirectWsTransport 链路不保留（web 调试直连走 `src/ssh/webDirect.ts` 独立路径） | 2026-09-02 |
| D011 | 录音自研 HermesAudio 原生模块（Android MediaRecorder，m4a/AAC），替代 react-native-audio-recorder-player | 不引回该库：3.x 与 RN 0.87 编译不兼容，4.x Nitro 预生成代码与 nitro-modules 不匹配 | 2026-09-02 |
| D012 | Web 端调试走 `npm run web`（vite + react-native-web + 原生模块打桩 + web-only 直连入口） | 原生模块必须有 web 桩实现；web 端验证不替代真机验证 | 2026-09-02 |
| D013 | multiplex 会话归属纯客户端实现：SSH exec 只读 sqlite3 扫 session_key 命名空间建映射，foreign 会话只读、首次发送派生 `session.create(parent_session_id)` | 宿主 sqlite 只读；不改服务端（D003）；foreign 会话不写入原 profile | 2026-09-02 |
| D014 | 助手气泡 markdown 渲染：native 用 react-native-markdown-display，web 分叉 `MarkdownText.web.tsx`（markdown-it → HTML，因库主入口是未编译 JSX） | 双实现仅此一处（UI 其余单源）；库的渲染缺陷不改库源码，渲染前改写标记绕过（如列表 → 文本前缀） | 2026-09-02（09-04 修订补充列表方案） |
| D015 | 助手气泡文本选择最终方案：ChatScreen 普通窗口树内全屏选择层 + `editable` + `showSoftInputOnFocus=false` + `caretHidden` 的多行 TextInput | 不可放回 RN Modal（Android 系统选择菜单弹出即关）；不可用 readOnly（Android 完全不可选）；不可丢边缘自动滚动（只有自带滚动的多行 TextInput 做得到） | 2026-09-03 |
| D016 | 键盘避让手动测量：`useKeyboardHeight`（keyboardDidShow/Hide），按 `windowH - screenY` 计算真实遮挡区垫高 | 不用 KeyboardAvoidingView（Android edge-to-edge + adjustNothing 下不可靠）；遮挡区不得用 event.height（少报一个导航条/安全区高度） | 2026-09-03 |
| D017 | 模型切换列表自定义 provider 优先：前端 ModelPicker 按 `is_user_defined` 稳定分区提前，否决「改 hermes 配置/服务端统一顺序」路径 | hermes 无排序配置面：`model.options` 固定 `canonical_order=True`，`_reorder_canonical` 按 `CANONICAL_PROVIDERS` 硬编码声明序排内置、`custom:*` 无条件垫底，TUI/dashboard 同源同序；不改服务端（D003），组内保持服务端返回的相对顺序 | 2026-09-05 |
| D018 | 界面图标用现成 Tabler Icons PNG（240px base64 data URI 存 `src/assets/icons.ts`，`IconImage` tintColor 着色），否决手绘 View 图标与 react-native-vector-icons 图标库 | 零原生/零字体配置（数据 URI 原生与 web 通吃，tsc+web 即可完全验证，不需等 构建机）；图标库要改安卓 gradle 引字体，违背 D002 的本机验证边界；新图标一律先查 Tabler（MIT）补进 icons.ts | 2026-09-05 |
| D019 | 所有 REST 调用必须带超时：`rest.ts` 统一 AbortController 30s（对齐 WS RPC 层 requestTimeoutMs），长流程外层再加 Promise.race 兜底 | RN fetch 默认永不超时——SSH 隧道半开（锁屏/切网后静默断开）时请求无限挂起，是「语音一直识别中」类卡死 UI 的根因；新 REST 端点不得裸 fetch | 2026-09-05 |
| D020 | 语音识别语言问题**暂不处理**（用户 2026-09-05 决定）：识别语言完全由服务端决定，`/api/audio/transcribe` 无 language 参数，客户端无法指定 | 不改服务端（D003）；实测 faster-whisper `base` 自动检测把 ≤7s 中文全误判 `lang=en`（服务端日志实锤），要修只能用户自己改服务端配置（`stt.local.language: zh` / 换 `small` 模型）或给上游提 issue 加 language 参数；App 侧留待上游支持后再传语言 | 2026-09-05 |
