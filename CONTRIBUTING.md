# 贡献指南

感谢你有兴趣改进 HermesChat。这个项目维护者不多，所以**小而有针对性的 PR 远比大而全的重构容易合并**。

## 开始之前

请先读这几个文件，它们能省掉大量来回：

| 文件 | 内容 |
|---|---|
| [`AGENTS.md`](AGENTS.md) | 项目规范：不可改动的外部系统、构建边界、代码约定、**敏感信息纪律** |
| [`PROGRESS.md`](PROGRESS.md) | 当前进度、待办、以及大量「踩坑」记录 |
| [`DECISIONS.md`](DECISIONS.md) | 架构与技术选型决策（含被否决的方案及原因） |
| [`docs/`](docs/) | `plan.md` 总体设计、`protocol.md` 协议细节、`ssh-module.md` 原生模块契约、`desktop.md` 桌面端方案 |

**动手前建议先开 Issue 讨论**，尤其是涉及协议层、原生模块、依赖引入的改动——`DECISIONS.md` 里可能已经记录过为什么没那样做。

## 开发环境

- Node.js ≥ 22.11
- 只改 JS/TS 层时，**不需要** Android/iOS 工具链
- 跑真实端到端需要本机有 Hermes Agent 服务（`hermes serve` / `hermes dashboard`，默认 `127.0.0.1:9119`）

```bash
npm install
npx tsc --noEmit      # 类型检查
npm run lint          # eslint（当前 0 error）
npm test              # jest 单测
npm run web           # 浏览器调试（http://localhost:5188，可直连本机 gateway）
```

## 分支与提交

采用 trunk-based 开发，**没有 `develop` 分支**：

- `main` 永远保持可构建、可发布（受分支保护，CI 必须通过）
- 从 `main` 切临时分支：`feat/xxx`、`fix/xxx`、`chore/xxx`、`docs/xxx`
- 通过 PR 合并，合并后分支自动删除
- 只有需要同时维护旧版本时才会出现 `release/x.y` 长期分支

Commit messages are written in **English** (since 2026-09-14; previously Chinese), in the form:

```
<type>: <one-line summary of what changed>

(optional) body: why the change was made, side effects to watch
```

Use one of these types: `feat` / `fix` / `docs` / `refactor` / `perf` / `test` / `chore` / `build`.

## 贡献者声明（DCO）

本项目采用 [AGPL-3.0-or-later](LICENSE)。提交 PR 即表示你同意以该许可发布你的贡献。

请在每个提交信息末尾加一行：

```
Signed-off-by: 你的名字 <你的邮箱>
```

（`git commit -s` 会自动加上。）这是 [Developer Certificate of Origin](https://developercertificate.org/) 的声明，表示你有权提交这份代码。**我们目前不要求签 CLA**。

## 代码约定

- **UI 文案与代码注释一律用中文。**
- **zustand 选择器必须返回稳定引用**——禁止 `useStore(s => s.list ?? [])` 这类内联新对象/新数组，会导致无限重渲染。
- **原生能力差异一律收敛在 `src/ssh/`**（`HermesSsh` 契约 + 各平台实现），UI 与协议层必须保持平台无关。
- **不要修改 Hermes Agent 服务端**。本项目只使用官方公开协议（WS JSON-RPC + REST），任何「必须改服务端才能实现」的需求都应先开 Issue 讨论。
- 新增页面/组件请对齐既有页面的 `placeholderTextColor`、设计 token（`src/components/theme.ts`）等口径。

## ⚠ 敏感信息纪律（重要）

本仓库是公开仓库。**PR 中不得包含任何本机/个人专属信息**：

- 真实主机名与 SSH 别名、内网/公网 IP、用户名与绝对家目录路径（一律写 `~` 或占位符）
- 设备序列号、API key / token / 密码 / 私钥 / 个人邮箱
- **真实的会话标题、聊天正文、profile 名称**——截图里也不行

本机专属值请走环境变量或 gitignored 配置文件（先例见 `scripts/build-env.example.sh`）。示例值一律用 `example.com`、`192.168.1.10`、`buildhost` 这类明显的占位符。

提交前请自查：

```bash
git diff --cached | grep -inE "/Users/|C:\\\\Users|@gmail|BEGIN .*PRIVATE KEY"
```

带真实数据的截图请只放本地（`docs/screenshots/` 已 gitignore）。需要配图时用 `scripts/mock-gateway.js` 的假数据重拍。

## 测试

- 修 bug 请**尽量补一个能复现该 bug 的测试**（jest）。这是这个项目最主要的回归防线。
- 涉及 UI 行为的改动，可以加/跑 `scripts/*-smoke.js` 里的 Playwright 冒烟脚本（配合 `scripts/mock-gateway.js`，不接触真实服务）：

```bash
node scripts/web-scroll-follow-smoke.js      # 自起 mock + build + preview，全自动
```

- 提交前请确保 `npx tsc --noEmit`、`npm run lint`、`npm test` 三项全绿——CI 会跑同样的三条。

## 文档同步

改了以下内容请**同步更新对应文档**（`AGENTS.md` 有强制要求）：

| 改动 | 需同步 |
|---|---|
| 协议理解 / RPC 调用方式 | `docs/protocol.md` |
| `src/ssh/` 原生模块契约 | `docs/ssh-module.md` |
| 总体设计 / 功能范围 | `docs/plan.md` |
| 完成一个功能单元或修掉一个 bug | `PROGRESS.md`（含「踩坑」记录） |
| 架构/选型取舍、方案否决 | `DECISIONS.md`（用新 ID 引用旧 ID，旧条目不删） |

## 我们可能不会合并的改动

- 大规模格式化 / 重命名 / 目录重组（会淹没 diff，请拆成独立 PR 并先讨论）
- 引入重量级依赖，尤其是会改动 Android/iOS 原生构建链的
- 修改服务端、或依赖对服务端定制的实现
- 把 UI 文案或注释改成英文（除非是 i18n 方案的一部分，且需先讨论）

## 许可

提交贡献即表示你同意你的代码以 [AGPL-3.0-or-later](LICENSE) 发布。
