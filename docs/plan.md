# HermesChat — Hermes 远程操控手机端 App 设计方案（已批准）

> 本文档是已批准的总体设计。协议细节见 `docs/protocol.md`，SSH 原生模块契约见 `docs/ssh-module.md`。

## 1. 目标与范围

React Native (TS) 手机 App（Android 优先，iOS 后续），通过 **App 内置 SSH 全自动隧道** 连接远端电脑上运行的 Hermes Agent 后端（`hermes serve` / `hermes dashboard`，FastAPI，默认 `127.0.0.1:9119`），提供类 QQ 的多 profile 多会话聊天体验。

**v1 功能**（对齐 web dashboard 的对话体验）：
- 多 profile：头像 + 昵称的 profile 列表（QQ 风格），每个 profile 独立会话列表
- 多会话：新建 / 切换 / 恢复历史 / 删除 / 重开（reset）
- 聊天渲染：流式文本、思考/推理过程、工具调用过程（可折叠卡片）、报错信息
- 权限审批：事件驱动的弹窗按钮（once / session / always / deny），不手输指令
- 模型切换：底部弹出选择器（`model.options` + `config.set`）
- 连接持久化：SSH 断线自动重连 + WS 断线 `session.resume` 恢复

**v2 预留**（已于 M3 提前实现）：图片（`image.attach_bytes`）、文件（`file.attach`）、语音（`/api/audio/transcribe` STT + 手机录音）、profile 昵称/头像编辑（`profiles.configure` ui_meta / `profiles.set_asset`）。

**v3 定时任务管理**（2026-09-10 实现，协议见 `docs/protocol.md` §7，D038）：主页左上角标题位改视图切换控件（会话 | 定时任务，默认会话），定时任务视图 = dashboard cron 管理的移动端对齐——任务列表（状态徽章/计划人性化描述/上下次运行/错误明细 + profile 筛选）、控制（暂停/恢复、立即运行、删除）、运行历史（每任务最近运行会话，可点进聊天查看）、新建/编辑表单（六模式计划构建器：间隔/每天/每周/每月/一次性/自定义表达式 + 投递目标 + 归属 profile + 跟随上次输出）。三端同源：手机导航栈（CronRuns/CronEdit 路由）+ 桌面/web 壳首屏切换与 Modal。高级字段（skills/model/workdir/script/toolsets/no_agent）暂不做表单，留 follow-up。

**构建策略（用户决定）**：不在本 Mac 装 Android/iOS 工具链；Android 构建在远端构建机上进行。本地只做 JS/TS 开发 + Node harness 验证 + jest/tsc 静态验证。iOS 暂缓。

## 2. 关键调研结论（已实测核实，Hermes v0.20.1）

- App 连的是 `hermes serve`/`hermes dashboard` 的 FastAPI 服务，**不是** `hermes gateway`（消息平台网关）。
- 线协议：WebSocket `GET /api/ws`，每帧一条 JSON-RPC 2.0；事件 `{"method":"event","params":{"type","session_id","payload"}}`。连接后服务端推 `gateway.ready`。
- 认证（loopback）：`ws://127.0.0.1:9119/api/ws?token=<SESSION_TOKEN>`。token 可从 SPA HTML 提取：`GET /` → `window.__HERMES_SESSION_TOKEN__="..."`（已实测可用）。
- 服务端无 TLS；官方推荐 loopback + SSH 隧道。官方 desktop SSH 参考实现：`apps/desktop/electron/ssh-connection.ts`、`remote-lifecycle.ts`（远端拉起 `hermes serve --isolated --host 127.0.0.1 --port 0`，抓 `HERMES_BACKEND_READY port=<n>`）。
- 多 profile：一个 serve 进程服务全部 profile；RPC 用 `params.profile` 作用域。profile 数量与命名由用户自定（实测环境为 `default` + 若干独立人格 profile，如 `main` / `finance` / `study` / `work`）。
- 断线恢复：WS 断开 ~20s 内 `session.resume` 可重挂进行中的 turn。
- **RN SSH 库调研结论**：`@dylankenneally/react-native-ssh-sftp`（NMSSH/JSch 封装）无端口转发 API，且 iOS 不支持模拟器 → 采用自研原生隧道模块（见 `docs/ssh-module.md`）。

## 3. 技术选型

| 层 | 选择 |
|---|---|
| 框架 | React Native 0.87.1 (TS)，bare workflow，包名 HermesChat |
| SSH | 自研原生模块 `HermesSsh`（Android: Kotlin + JSch mwiede fork；iOS 后续 SwiftNIO SSH） |
| WS | RN 内置 WebSocket |
| 状态 | Zustand；连接配置（含密码/私钥）AsyncStorage 持久化于 App 沙盒 |
| 导航 | react-navigation (native-stack) |
| UI | 自绘 QQ 风格气泡列表（inverted FlatList）；不引 reanimated（M0 保持简单） |

## 4. 架构

```
┌─────────────── 手机 App (RN) ───────────────┐      SSH (22)      ┌── 远端电脑 ──┐
│  Chat UI ──> Store(zustand) ──> RpcClient    │  ═══════════════> │ hermes serve │
│                    │              │          │  内置隧道 L:P     │ 127.0.0.1:P  │
│              SshManager ──> 127.0.0.1:L      │  自动重连          │  /api/ws     │
└──────────────────────────────────────────────┘                   └──────────────┘
```

- `SshManager`（`src/ssh/`）：连接配置 → exec 探测/拉起远端 serve → 本地端口转发 → 状态机 `disconnected→connecting→bootstrapping→tunneling→ready→reconnecting`，指数退避 1s→30s，keepalive。
- `RpcClient`（`src/rpc/`）：JSON-RPC 请求/响应配对 + 事件按 session 分发 + 消息聚合器（事件流 → TimelineItem[]）。
- Transport 抽象：仅 `SshTunnelTransport`（生产；开发直连已随多配置重构移除）。

## 5. UI 结构（QQ 风格）

- 连接主页：多配置卡片列表（点卡片一键直连）；编辑页：名称/主机/端口/用户/认证 + "自动连接"开关（全局唯一）。
- Profile 列表页：头像 + 昵称 + 模型角标 + 状态点（数据 `profiles.list`）。
- 会话列表页（按 profile）：`session.list {profile}`，左滑删除，顶部新会话。
- 聊天页：气泡流（用户/助手）；思考块（折叠灰字）、工具卡片（名称+参数+结果，可展开）、错误红条；审批卡片内联按钮组；顶栏菜单 = 模型切换（bottom sheet）/ 重开会话 / 会话信息；输入框发送 `prompt.submit`，长 turn 显示中断按钮。

## 6. 里程碑

- **M0**：工程初始化 ✓；Node harness 跑通 `session.create→prompt.submit→事件流→session.close`；RpcClient+聚合器 jest 测试；最小聊天 UI 代码完成（本地无法构建，交构建机构建验证）；原生 SSH 模块 Android 代码完成（不可本地编译，静态审查）。
- **M1**：多 profile 多会话完整 UI（头像/昵称/会话管理）、thinking/工具卡片/错误渲染。
- **M2**：审批按钮组、模型切换、会话重开、中断、连接状态条、断线重连真机验证。
- **M3**：图片/文件/语音。代码完成（2026-09-02）：聊天"＋"附件面板（相册图片多选→压缩上传→待发横条、文件→@file: 引用入输入框、语音录音→/api/audio/transcribe→文本入输入框）；图片/文件消息渲染（`@image:`/`@file:` 指令 + data URL 还原，走 /api/files/download?token=）；profile 昵称/头像编辑页。本地 tsc/lint/jest（69 测试）全绿；真机验证交构建机。
- **M4**：multiplex 会话 profile 归属分组。代码完成（2026-09-02）：SSH exec 只读 sqlite 构建 sessionId→归属映射（`src/ssh/namespaceMap.ts`），会话列表按归属分组（own+大库 foreign 合并、宿主排除他者）；foreign 会话不 resume（避免错人格 agent），只读 sqlite 直读历史展示 + 顶部提示条，首次发送经 `session.create {parent_session_id, messages}` 派生到当前 profile（forkMap 持久化，之后正常 resume）。关键协议限制（session.history 只认 live sid、持久化 id 4001）已实测并写入 `docs/protocol.md` §5。本地 tsc/lint/jest（93 测试）全绿；真机验证交构建机。
- **M5**：定时任务管理三端实现（2026-09-10，§1 v3）。代码完成：`rpc/cron.ts`（REST 封装）+ `store/cron.ts`（cron.changed 自接线）+ `utils/cronSchedule.ts`（六模式构建/回显/中文描述）+ ViewSwitcher/CronPanel/CronRunsPanel/CronJobForm（手机/桌面共用面板）+ 手机 CronRuns/CronEdit 路由 + 桌面壳首屏切换与 Modal。jest 294 全绿（新增 cronSchedule 14 + cronStore 7）、tsc 0 错；web 冒烟（vite 代理真连 live dashboard，只读）：视图切换/列表徽章/行菜单/运行历史/新建表单/模式切换全部 PASS。真机验证交构建机出包。

## 7. 风险

- 原生模块无法本地编译 → 代码严格保守（经典 NativeModule 而非 TurboModule，减少 codegen 构建风险），构建机首次构建时修。
- 远端 serve 拉起失败 → 复用已运行实例 + SPA token 提取；手动 token 输入兜底。
- profile 头像 → `profiles.get_asset`，无头像用昵称首字符色块。
