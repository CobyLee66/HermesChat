/**
 * 当前进程的 RpcClient 单例 + 事件总线接线。
 * 连接建立后由 connection store 设置；UI/其他 store 通过 getRpc() 发 RPC。
 */

import type {RpcClient} from './client';

let current: RpcClient | null = null;

export function setRpc(client: RpcClient | null) {
  current = client;
}

export function getRpc(): RpcClient {
  if (!current) {
    throw new Error('rpc not connected');
  }
  return current;
}

/** 测试与重连用：是否有活连接。 */
export function hasRpc(): boolean {
  return current !== null && current.isOpen;
}
