/**
 * desktopHermesSsh — 桌面壳（Electron）下 window.hermesDesktop 的 typed wrapper。
 *
 * 导出面与 src/ssh/HermesSsh.ts（Android 原生 wrapper）保持一致，作为 web 构建
 * 中 './HermesSsh' 的解析目标（vite alias）：transport.ts / SshManager 的消费面
 * 完全不变。三类运行环境同一份代码：
 * - Electron 桌面：window.hermesDesktop 存在 → IPC 委托主进程 ssh2，isAvailable=true
 * - 普通浏览器：桥不存在 → 全部 reject（原 web 打桩语义），isAvailable=false
 * - Jest/测试：同浏览器分支
 */

import type {ExecResult, SshConfig} from './hermesSshTypes';

export type {ExecResult, SshConfig} from './hermesSshTypes';

/** 主进程经 preload 暴露的桥接口（方法面 = HermesSsh 契约 + 桌面能力）。 */
export interface DesktopBridge {
  connect(config: {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
  }): Promise<{serverFingerprint: string}>;
  exec(
    command: string,
    timeoutMs: number,
  ): Promise<ExecResult>;
  startCommand(command: string): Promise<{taskId: string}>;
  stopCommand(taskId: string): Promise<void>;
  openLocalForward(remotePort: number): Promise<{localPort: number}>;
  closeLocalForward(localPort: number): Promise<void>;
  disconnect(): Promise<void>;
  onStdout(taskId: string, cb: (line: string) => void): () => void;
  onExit(taskId: string, cb: (exitCode: number) => void): () => void;
  onDisconnect(cb: (reason: string) => void): () => void;

  /** 桌面能力：文件/图片选择对话框（主进程 dialog） */
  pickFiles(opts: {
    images: boolean;
    multiple: boolean;
  }): Promise<{path: string; name: string}[]>;
  /** 读本地文件为 data URL（主进程 fs） */
  readFileDataUrl(filePath: string): Promise<string>;
  /** 读本地文本文件（SSH 私钥 PEM 等场景，utf8） */
  readFileText(filePath: string): Promise<string>;
  /** 系统通知（点击通知聚焦窗口） */
  notify(payload: {title: string; body: string}): Promise<boolean>;
}

/** Electron 主进程桥是否存在（普通浏览器/Jest 下为 false）。 */
export function getDesktopBridge(): DesktopBridge | undefined {
  const w = globalThis as unknown as {hermesDesktop?: DesktopBridge};
  return w.hermesDesktop;
}

export function hasDesktopBridge(): boolean {
  return getDesktopBridge() != null;
}

export const isAvailable = hasDesktopBridge();

export const DEFAULT_EXEC_TIMEOUT_MS = 20_000;

function unavailableError(method: string): Error {
  return new Error(
    `SSH 桥在当前环境不可用（${method}）。桌面版需 Electron 壳；浏览器请使用「浏览器直连」。`,
  );
}

export function connect(
  config: SshConfig,
): Promise<{serverFingerprint: string}> {
  const bridge = getDesktopBridge();
  if (!bridge) {
    return Promise.reject(unavailableError('connect'));
  }
  return bridge.connect({port: 22, ...config});
}

export function exec(
  command: string,
  timeoutMs: number = DEFAULT_EXEC_TIMEOUT_MS,
): Promise<ExecResult> {
  const bridge = getDesktopBridge();
  if (!bridge) {
    return Promise.reject(unavailableError('exec'));
  }
  return bridge.exec(command, timeoutMs);
}

export function startCommand(command: string): Promise<{taskId: string}> {
  const bridge = getDesktopBridge();
  if (!bridge) {
    return Promise.reject(unavailableError('startCommand'));
  }
  return bridge.startCommand(command);
}

export function stopCommand(taskId: string): Promise<void> {
  const bridge = getDesktopBridge();
  if (!bridge) {
    return Promise.reject(unavailableError('stopCommand'));
  }
  return bridge.stopCommand(taskId);
}

export function openLocalForward(
  remotePort: number,
): Promise<{localPort: number}> {
  const bridge = getDesktopBridge();
  if (!bridge) {
    return Promise.reject(unavailableError('openLocalForward'));
  }
  return bridge.openLocalForward(remotePort);
}

export function closeLocalForward(localPort: number): Promise<void> {
  const bridge = getDesktopBridge();
  if (!bridge) {
    return Promise.reject(unavailableError('closeLocalForward'));
  }
  return bridge.closeLocalForward(localPort);
}

export function disconnect(): Promise<void> {
  const bridge = getDesktopBridge();
  if (!bridge) {
    return Promise.reject(unavailableError('disconnect'));
  }
  return bridge.disconnect();
}

export function onStdout(
  taskId: string,
  cb: (line: string) => void,
): () => void {
  const bridge = getDesktopBridge();
  if (!bridge) {
    return () => {};
  }
  return bridge.onStdout(taskId, cb);
}

export function onExit(
  taskId: string,
  cb: (exitCode: number) => void,
): () => void {
  const bridge = getDesktopBridge();
  if (!bridge) {
    return () => {};
  }
  return bridge.onExit(taskId, cb);
}

export function onDisconnect(cb: (reason: string) => void): () => void {
  const bridge = getDesktopBridge();
  if (!bridge) {
    return () => {};
  }
  return bridge.onDisconnect(cb);
}
