/**
 * HermesSsh.ts — SSH 隧道原生模块的 JS typed wrapper。
 *
 * 契约见 docs/ssh-module.md §2。封装 NativeModules.HermesSsh + NativeEventEmitter：
 * - 全部方法 Promise 化（native 侧已在线程池执行）。
 * - 原生模块缺失（web / Jest / 未链接的构建）时 isAvailable=false，
 *   方法调用 reject、事件订阅返回 no-op 取消函数，绝不抛同步异常。
 */

import { NativeEventEmitter, NativeModules } from 'react-native';

export interface SshConfig {
  host: string;
  port?: number; // 默认 22
  username: string;
  password?: string; // 密码认证
  privateKey?: string; // PEM 内容（优先于密码）
  passphrase?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface NativeHermesSshModule {
  connect(config: Required<Pick<SshConfig, 'host' | 'port' | 'username'>> & Omit<SshConfig, 'host' | 'port' | 'username'>): Promise<{ serverFingerprint: string }>;
  exec(command: string, timeoutMs: number): Promise<ExecResult>;
  startCommand(command: string): Promise<{ taskId: string }>;
  stopCommand(taskId: string): Promise<void>;
  openLocalForward(remotePort: number): Promise<{ localPort: number }>;
  closeLocalForward(localPort: number): Promise<void>;
  disconnect(): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

const native: NativeHermesSshModule | undefined = NativeModules.HermesSsh;

/** 原生模块是否可用（Android 且已链接）。web/测试环境下为 false。 */
export const isAvailable = native != null;

export const DEFAULT_EXEC_TIMEOUT_MS = 20_000;

function unavailableError(method: string): Error {
  return new Error(`HermesSsh native module is not available (${method})`);
}

let sharedEmitter: NativeEventEmitter | null = null;

function getEmitter(): NativeEventEmitter | null {
  if (!native) {
    return null;
  }
  if (!sharedEmitter) {
    sharedEmitter = new NativeEventEmitter(native);
  }
  return sharedEmitter;
}

export function connect(config: SshConfig): Promise<{ serverFingerprint: string }> {
  if (!native) {
    return Promise.reject(unavailableError('connect'));
  }
  return native.connect({ port: 22, ...config });
}

export function exec(
  command: string,
  timeoutMs: number = DEFAULT_EXEC_TIMEOUT_MS,
): Promise<ExecResult> {
  if (!native) {
    return Promise.reject(unavailableError('exec'));
  }
  return native.exec(command, timeoutMs);
}

/**
 * 长驻命令（远端 hermes serve 用）。stdout 每行经 onStdout 推送；
 * 频道结束经 onExit 推送 {exitCode}（被 stopCommand/断开杀掉时为 -1）。
 */
export function startCommand(command: string): Promise<{ taskId: string }> {
  if (!native) {
    return Promise.reject(unavailableError('startCommand'));
  }
  return native.startCommand(command);
}

export function stopCommand(taskId: string): Promise<void> {
  if (!native) {
    return Promise.reject(unavailableError('stopCommand'));
  }
  return native.stopCommand(taskId);
}

/** 等价 ssh -L 127.0.0.1:0:127.0.0.1:remotePort，resolve 实际分配的本地端口。 */
export function openLocalForward(
  remotePort: number,
): Promise<{ localPort: number }> {
  if (!native) {
    return Promise.reject(unavailableError('openLocalForward'));
  }
  return native.openLocalForward(remotePort);
}

export function closeLocalForward(localPort: number): Promise<void> {
  if (!native) {
    return Promise.reject(unavailableError('closeLocalForward'));
  }
  return native.closeLocalForward(localPort);
}

export function disconnect(): Promise<void> {
  if (!native) {
    return Promise.reject(unavailableError('disconnect'));
  }
  return native.disconnect();
}

// ---------------------------------------------------------------------------
// 事件订阅（返回取消订阅函数；模块不可用时返回 no-op）
// ---------------------------------------------------------------------------

export function onStdout(taskId: string, cb: (line: string) => void): () => void {
  const emitter = getEmitter();
  if (!emitter) {
    return () => {};
  }
  const sub = emitter.addListener(
    `HermesSsh:stdout:${taskId}`,
    (event: unknown) => cb((event as { line: string }).line),
  );
  return () => sub.remove();
}

export function onExit(
  taskId: string,
  cb: (exitCode: number) => void,
): () => void {
  const emitter = getEmitter();
  if (!emitter) {
    return () => {};
  }
  const sub = emitter.addListener(
    `HermesSsh:exit:${taskId}`,
    (event: unknown) => cb((event as { exitCode: number }).exitCode),
  );
  return () => sub.remove();
}

/** 非主动断开（keepalive 超时 / 传输层错误）时触发。 */
export function onDisconnect(cb: (reason: string) => void): () => void {
  const emitter = getEmitter();
  if (!emitter) {
    return () => {};
  }
  const sub = emitter.addListener(
    'HermesSsh:disconnect',
    (event: unknown) => cb((event as { reason: string }).reason),
  );
  return () => sub.remove();
}
