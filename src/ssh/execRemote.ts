/**
 * execRemote.ts — 远端只读 exec 能力注册表（仿 rpc/runtime.ts 的 setRpc/getRpc）。
 *
 * SSH 隧道连接成功后由 connection store 注入（connector.execRemote），
 * web 直连/断线时为 null。用途：multiplex 会话归属扫描与 foreign 会话
 * 历史的只读 sqlite 查询（见 ssh/namespaceMap.ts、ssh/remoteHistory.ts）。
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ExecRemoteFn = (
  command: string,
  timeoutMs?: number,
) => Promise<ExecResult>;

let current: ExecRemoteFn | null = null;

export function setExecRemote(fn: ExecRemoteFn | null): void {
  current = fn;
}

export function getExecRemote(): ExecRemoteFn | null {
  return current;
}
