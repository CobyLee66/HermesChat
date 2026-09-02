# HermesMobile 项目规范

## 不可改动的外部系统

**绝对不要修改 Hermes Agent 服务端的源码/配置/数据**（`~/.hermes/`、gateway、dashboard、state.db 等）。本 App 必须适配官方版 hermes 的公开协议（WS JSON-RPC + REST），不能依赖对服务端的定制。

- 如果遇到**不修改 hermes 就无法实现**的功能：停下来向用户说明情况并确认方案，由用户决定（改官方源码 / 报上游 issue / 换实现路径 / 放弃该功能）。禁止擅自打补丁。
- 允许：只读探查源码确认协议细节；对只读 RPC 的实测调用。
- 禁止对 live 服务（127.0.0.1:9119）的写操作（prompt.submit / session.create / config.set / profiles.configure 等），除非用户明确批准本次验证。
- 重启用户机器上的 hermes 相关服务（dashboard/gateway 等 launchd 任务）前必须先告知用户。

## 构建与验证

- 本机（MacBook）无 Android 工具链：JS 改动用 `npx tsc --noEmit`、`npm run lint`、`npm test`、`npm run web`（浏览器调试）验证。
- APK 构建在 构建机（Windows，SSH 别名 `构建机`）：`scripts/build-android.sh`（推 GitHub → 构建机 拉取构建 → 取回 dist/ → 检测到手机则自动安装）。不要在这台 Mac 上装 Android/iOS 工具链。
- 构建机 上的 `C:\HermesMobile` 是构建副本，一切修改从 GitHub 拉取，不要在上面手改。

## 代码约定

- UI 文案与代码注释用中文；zustand 选择器必须返回稳定引用（禁止 `?? []` 内联新对象）；原生能力差异收敛在 `src/ssh/`（HermesSsh 契约 + 各平台实现），UI/协议层保持平台无关。
