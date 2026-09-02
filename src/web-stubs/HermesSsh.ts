/**
 * web 打桩：SSH 隧道原生模块（vite alias 替换 ../ssh/HermesSsh，仅 web 构建使用）。
 * 浏览器无 SSH 能力：isAvailable=false，方法一律 reject，事件订阅返回 no-op。
 * 导出表面与 src/ssh/HermesSsh.ts 保持一致（transport.ts 的消费面）。
 */

export interface SshConfig {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export const isAvailable = false;

export const DEFAULT_EXEC_TIMEOUT_MS = 20_000;

function unavailable(method: string): Promise<never> {
  return Promise.reject(
    new Error(`SSH 原生模块在浏览器中不可用（${method}），请使用「浏览器直连」`),
  );
}

export function connect(): Promise<{serverFingerprint: string}> {
  return unavailable('connect');
}

export function exec(): Promise<ExecResult> {
  return unavailable('exec');
}

export function startCommand(): Promise<{taskId: string}> {
  return unavailable('startCommand');
}

export function stopCommand(): Promise<void> {
  return unavailable('stopCommand');
}

export function openLocalForward(): Promise<{localPort: number}> {
  return unavailable('openLocalForward');
}

export function closeLocalForward(): Promise<void> {
  return unavailable('closeLocalForward');
}

export function disconnect(): Promise<void> {
  return unavailable('disconnect');
}

export function onStdout(): () => void {
  return () => {};
}

export function onExit(): () => void {
  return () => {};
}

export function onDisconnect(): () => void {
  return () => {};
}
