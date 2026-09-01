# HermesSsh 原生隧道模块契约

> 目的：RN 内置 SSH 全自动隧道。现有 RN SSH 库（react-native-ssh-sftp 系列）无端口转发 API 且 iOS 不支持模拟器，故自研薄原生模块。Android 优先（Kotlin + JSch），iOS 后续（SwiftNIO SSH）。
> 设计参照官方 desktop：`apps/desktop/electron/ssh-connection.ts`（ControlMaster 思路）、`apps/desktop/electron/remote-lifecycle.ts`（远端拉起 hermes serve 流程）。

## 1. 构建约束（重要）

- **经典 NativeModule（ReactContextBaseJavaModule），不要 TurboModule/codegen** —— 首次构建在远端 构建机 进行，本地无法编译验证，必须最大限度降低构建风险。RN 0.87 新架构对经典模块有 interop 支持。
- JSch 用 mwiede 维护分支：`com.github.mwiede:jsch:0.2.18`（或构建时可解析的最新 0.2.x）。在 `android/app/build.gradle` 加依赖。
- 不引入其他原生依赖。AndroidManifest 已有 INTERNET 权限（RN 模板自带，核实即可）。

## 2. JS API（`src/ssh/HermesSsh.ts` 封装 `NativeModules.HermesSsh`）

全部为 Promise 方法；所有 native 操作在线程池中，不阻塞 UI。

```ts
export interface SshConfig {
  host: string;
  port: number;            // 默认 22
  username: string;
  password?: string;       // 密码认证
  privateKey?: string;     // PEM 内容（优先于密码）
  passphrase?: string;
}

export interface ExecResult { stdout: string; stderr: string; exitCode: number; }

connect(config: SshConfig): Promise<{ serverFingerprint: string }>
exec(command: string, timeoutMs: number): Promise<ExecResult>
// 长驻命令：为远端 hermes serve 设计。stdout 每行通过事件 "HermesSsh:stdout:<taskId>" 推送；
// 进程退出/频道关闭推 "HermesSsh:exit:<taskId>" {exitCode}。返回 {taskId}。
// channel 生命周期 = 远端进程生命周期（channel 关闭则进程被杀），JS 侧据此管理。
startCommand(command: string): Promise<{ taskId: string }>
stopCommand(taskId: string): Promise<void>
// 本地端口转发：等价 ssh -L 127.0.0.1:0:127.0.0.1:<remotePort>
// JSch: session.setPortForwardingL("127.0.0.1", 0, "127.0.0.1", remotePort) 返回实际本地端口
openLocalForward(remotePort: number): Promise<{ localPort: number }>
closeLocalForward(localPort: number): Promise<void>
disconnect(): Promise<void>
```

事件（NativeEventEmitter）：`HermesSsh:disconnect`（非主动断开时发，payload `{reason}`）。
keepalive：native 侧 `session.setServerAliveInterval(15000)` + `setServerAliveCountMax(3)`。
重连策略在 JS 层（SshManager）实现：指数退避 1s→30s，监听 RN AppState + NetInfo 与 `HermesSsh:disconnect`。

## 3. Bootstrap 流程（JS 侧 SshManager 实现，native 只提供原语）

1. `connect(config)`。
2. `exec("command -v hermes && hermes --version")` 探测安装。
3. 复用优先：`exec("curl -s -m 2 http://127.0.0.1:9119/api/health")` 有响应 → 已运行实例，`exec("curl -s http://127.0.0.1:9119/ | grep -oE '__HERMES_SESSION_TOKEN__=\"[^\"]+\"'")` 提取 token，remotePort=9119。
4. 否则拉起：生成随机 token，`startCommand("HERMES_DASHBOARD_SESSION_TOKEN=<token> hermes serve --isolated --host 127.0.0.1 --port 0")`，从 stdout 事件解析 `HERMES_BACKEND_READY port=(\d+)`。
5. `openLocalForward(remotePort)` → JS 连 `ws://127.0.0.1:<localPort>/api/ws?token=<token>`。
6. 全部失败 → 允许用户手动填 host/port/token 直连（兜底）。

## 4. 文件清单（Android）

- `android/app/src/main/java/com/hermesmobile/ssh/HermesSshModule.kt` — 模块实现
- `android/app/src/main/java/com/hermesmobile/ssh/HermesSshPackage.kt` — Package 注册
- `android/app/src/main/java/com/hermesmobile/MainApplication.kt` — 注册 HermesSshPackage（按模板实际包名/语言调整，模板可能是 .kt）
- `android/app/build.gradle` — JSch 依赖
- `src/ssh/HermesSsh.ts` — JS 侧 typed wrapper
- `src/ssh/SshManager.ts` — 状态机 + bootstrap + 重连（由 JS core 任务实现，本契约只规定它消费上面的 API）

## 5. Transport 抽象（JS 层）

```ts
export interface Transport {
  connect(): Promise<{ wsUrl: string; httpUrl: string; token?: string }>
  disconnect(): Promise<void>
  onDrop?: () => void  // 意外断开回调
}
```
- `DirectWsTransport`（开发）：`wsUrl=ws://127.0.0.1:9119/api/ws?token=<提取或手填>`。
- `SshTunnelTransport`（生产）：走 §3 流程。

## 6. Android 实现备注（首次落地记录）

**HostKey 策略（accept-new 等价）**：JSch 无 `accept-new` 选项，实现为 `StrictHostKeyChecking=ask` + 模块内置 `AcceptNewUserInfo`（`HermesSshModule.kt` 文件尾部）：
- 未知主机：authenticity 提示自动应答 yes，JSch 经 `HostKeyRepository.add()` 持久化到 app 私有文件 `filesDir/hermes_known_hosts`（`jsch.setKnownHosts`，文件不存在时首次写入自动创建）。
- 已知主机密钥变更：`promptYesNo` 对 "HAS CHANGED" 提示一律应答 no → `connect` reject，fail closed（错误消息含 "HostKey has been changed"）。

**超时/keepalive 常量**：connect 15s（对齐 desktop），channel open 10s，exec 超时由参数传入（JS wrapper 默认 20s）；`setServerAliveInterval(15000)` + `setServerAliveCountMax(3)`。

**断连探测**：keepalive 超时/传输错误后 JSch 内部置 session 断开；native 侧 2s 间隔 watchdog 轮询 `session.isConnected()`，仅对"当前会话且非主动断开"发一次 `HermesSsh:disconnect` {reason}。注意：JSch 不提供断开原因，`reason` 为通用字符串（"connection lost (keepalive timeout or transport error)"）。

**`serverFingerprint` 格式**：JSch 0.2.x 默认 `FingerprintHash=sha256`，返回 `"SHA256:xxxx..."`（不含算法名前缀）。

**Promise 错误码**：`E_NOT_CONNECTED`（未连接时调 exec/forward/startCommand）、`E_CONNECT_FAILED`、`E_EXEC_FAILED`、`E_EXEC_TIMEOUT`、`E_CHANNEL_FAILED`、`E_FORWARD_FAILED`、`E_NOT_AVAILABLE`（模块销毁中）。

**幂等与边界语义**：
- `stopCommand`（含未知 taskId）、`closeLocalForward`、`disconnect` 均幂等 resolve。
- 被 `stopCommand`/断连杀掉的 task，`HermesSsh:exit:<taskId>` 的 `exitCode` 为 **-1**；exit 事件每 task 恰好发一次（读线程 finally 统一发）。
- `startCommand` 的 stderr 不进事件流，native 侧排空丢弃（防止远端写满通道窗口阻塞）。
- `exec` 单条流（stdout/stderr）收集上限 8 MiB，超出部分丢弃但继续排空。
- `connect` 重复调用会先静默断开旧会话（不触发 `HermesSsh:disconnect`），再建新连接。
- RN reload（`invalidate()`）时全量清理 channel/forward/session/线程池。
- `openLocalForward` 绑定 `127.0.0.1:0`，由 JSch PortWatcher 分配实际端口并回传（等价 `ssh -L 127.0.0.1:0:...`）。
