# HermesMobile 项目规范

## 不可改动的外部系统

**绝对不要修改 Hermes Agent 服务端的源码/配置/数据**（`~/.hermes/`、gateway、dashboard、state.db 等）。本 App 必须适配官方版 hermes 的公开协议（WS JSON-RPC + REST），不能依赖对服务端的定制。

- 如果遇到**不修改 hermes 就无法实现**的功能：停下来向用户说明情况并确认方案，由用户决定（改官方源码 / 报上游 issue / 换实现路径 / 放弃该功能）。禁止擅自打补丁。
- 允许：只读探查源码确认协议细节；对只读 RPC 的实测调用。
- 禁止对 live 服务（127.0.0.1:9119）的写操作（prompt.submit / session.create / config.set / profiles.configure 等），除非用户明确批准本次验证。
- 重启用户机器上的 hermes 相关服务（dashboard/gateway 等 launchd 任务）前必须先告知用户。

## 构建与验证

- 本机（MacBook）无 Android 工具链：JS 改动用 `npx tsc --noEmit`、`npm run lint`、`npm test`、`npm run web`（浏览器调试）验证。
- APK 构建在 构建机（Windows，SSH 别名 `构建机`）：Mac 远程驱动用 `scripts/build-android-remote.sh`（推 GitHub → 构建机 拉取 → 远端构建 → 取回 dist/ → 检测到手机则自动安装）；构建机 本机（Git Bash）构建用 `scripts/build-android.sh`（仅 npm ci + gradlew 构建 + adb 安装，不做 git 同步）。不要在这台 Mac 上装 Android/iOS 工具链。
- 构建机 上的 `C:\HermesMobile` 是构建副本，一切修改从 GitHub 拉取，不要在上面手改。

## 代码约定

- UI 文案与代码注释用中文；zustand 选择器必须返回稳定引用（禁止 `?? []` 内联新对象）；原生能力差异收敛在 `src/ssh/`（HermesSsh 契约 + 各平台实现），UI/协议层保持平台无关。

## 进度与决策文档

- **`PROGRESS.md` / `DECISIONS.md` 是跨会话上下文的唯一落盘处**：稳定约束必须写入文件（AGENTS.md / DECISIONS.md / docs/），禁止依赖会话记忆——自动摘要会丢早期指令。
- **新会话启动必读 `PROGRESS.md`**（了解当前进度与待办）；涉及架构/技术选型的工作再读 `DECISIONS.md`。
- **进度更新时机**：每完成一个功能单元（一个界面、一个模块、一个 bugfix）立即更新 `PROGRESS.md`，不攒到会话结束。
- **上下文降级协议**：当用户反复纠正「我之前说过」时，说明上下文已降级，应主动建议开新会话，并从 AGENTS.md + PROGRESS.md + DECISIONS.md 重建上下文。

### Decision Recording

涉及技术选型、架构取舍、方案否决时，必须记入 `DECISIONS.md`。

- **格式**：表格条目——ID（D0XX 顺序编号）+ 决策 + 不可让步点 + 日期；只记「为什么」，不复述「是什么」（实现细节在 docs/ 与代码里）。
- **修订/推翻**：用新 ID 引用旧 ID（如「修订 D004：…」），旧条目保留不删，保持可追溯。
- **归档触发（按内容量）**：活跃决策 > 50 条或文件 > 15KB 时，把已修订/已推翻/纯调研结论类移入 `DECISIONS_ARCHIVE.md`；保留仍构成当前代码约束的决策。归档 ≠ 删除，`D0XX` 编号是稳定锚点，其他文档引用编号即可定位。

### PROGRESS.md 维护

- **结构**：当前状态（进行中 / 最近完成 / 待办下一步）。
- **条目要素**：`[x]` 标题（功能名 + 日期 + 关联决策 ID）+ 一句话结果 + **⚠ 踩坑**（跨会话最有价值的部分，必须写）。
- **归档触发**：已完成条目 > 25 条或文件 > 20KB 时，压缩为一行摘要（功能名 + 日期 + 一句话 + 关键踩坑）移入 `PROGRESS_ARCHIVE.md`。

## 参考文档维护

| 文档 | 内容 | 读取时机 |
|------|------|---------|
| `docs/plan.md` | 总体设计方案（已批准） | 涉及整体架构/功能范围时 |
| `docs/protocol.md` | WS JSON-RPC + REST 协议细节与实测结论 | 改协议层/RPC 客户端时必读 |
| `docs/ssh-module.md` | SSH 原生模块契约 | 改 `src/ssh/` 原生能力时必读 |
| `docs/desktop.md` | 桌面端(Win/macOS)与 Web 版统一方案（未实现） | 做桌面端/Web 版时必读 |

**【强制】完成功能/协议/契约变更后同步更新文档**：改协议理解 → `docs/protocol.md`；改 SSH 原生模块 → `docs/ssh-module.md`；改总体设计 → `docs/plan.md`。

## 会话收尾检查清单

- [ ] `PROGRESS.md` 已更新（完成 / 进行中 / 待办下一步）
- [ ] `DECISIONS.md` 已更新（如有架构/选型决策）
- [ ] 相关 `docs/*.md` 已同步（如有协议/契约/设计变更）
