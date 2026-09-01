/**
 * JSON-RPC over WebSocket 客户端。
 * 职责：id 配对、事件分发、断线回调。自动重连由上层（SshManager/connection store）负责。
 * 环境无关（RN 与 Node 22+ 均有全局 WebSocket）。
 */

import type {
  GatewayEventFrame,
  JsonRpcRequest,
  ServerFrame,
} from './types';

export interface RpcClientOptions {
  /** 请求超时（ms），默认 30s */
  requestTimeoutMs?: number;
  /** 意外断开回调（connect 后 close/error 触发） */
  onClose?: (reason: string) => void;
}

type EventHandler = (event: GatewayEventFrame['params']) => void;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

export class RpcClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private handlers = new Map<string, Set<EventHandler>>();
  private anyHandlers = new Set<EventHandler>();
  private requestTimeoutMs: number;
  private onCloseCb?: (reason: string) => void;
  private closedByUs = false;
  /** connect() 完成后置 true；gateway.ready 到达后置 readySeen */
  readySeen = false;

  constructor(opts: RpcClientOptions = {}) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.onCloseCb = opts.onClose;
  }

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** 建立 WS 连接并等待 gateway.ready（服务端握手后立即推送）。 */
  connect(wsUrl: string): Promise<void> {
    this.closedByUs = false;
    this.readySeen = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      const readyTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            ws.close();
          } catch {
            // ignore
          }
          reject(new Error('timeout waiting for gateway.ready'));
        }
      }, this.requestTimeoutMs);

      ws.onopen = () => {
        // 等 gateway.ready，不在 open 时 resolve
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          reject(new Error('websocket connect failed'));
        }
      };
      ws.onclose = (ev: {code?: number; reason?: string}) => {
        const reason = `ws closed code=${ev?.code ?? '?'} ${ev?.reason ?? ''}`.trim();
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          reject(new Error(reason));
          return;
        }
        this.handleClose(reason);
      };
      ws.onmessage = (ev: {data?: unknown}) => {
        const raw = typeof ev.data === 'string' ? ev.data : '';
        if (!raw.trim()) {
          return;
        }
        let frame: ServerFrame;
        try {
          frame = JSON.parse(raw) as ServerFrame;
        } catch {
          return;
        }
        if ('method' in frame && frame.method === 'event') {
          const evt = frame.params;
          if (evt.type === 'gateway.ready' && !settled) {
            settled = true;
            clearTimeout(readyTimer);
            this.readySeen = true;
            resolve();
          }
          this.dispatch(evt);
          return;
        }
        // 响应帧
        const resp = frame as {id?: number; result?: unknown; error?: {code: number; message: string}};
        if (typeof resp.id === 'number') {
          const call = this.pending.get(resp.id);
          if (call) {
            this.pending.delete(resp.id);
            clearTimeout(call.timer);
            if (resp.error) {
              call.reject(new RpcError(resp.error.code, resp.error.message ?? 'rpc error'));
            } else {
              call.resolve(resp.result);
            }
          }
        }
      };
    });
  }

  private handleClose(reason: string) {
    // 失败所有 pending 请求
    for (const [, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(new Error(`connection lost: ${reason}`));
    }
    this.pending.clear();
    this.ws = null;
    if (!this.closedByUs && this.onCloseCb) {
      this.onCloseCb(reason);
    }
  }

  /** 主动断开（不触发 onClose）。 */
  disconnect() {
    this.closedByUs = true;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.onclose = null;
        ws.close();
      } catch {
        // ignore
      }
    }
    for (const [, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(new Error('disconnected'));
    }
    this.pending.clear();
  }

  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('not connected'));
    }
    const id = this.nextId++;
    const req: JsonRpcRequest = {jsonrpc: '2.0', id, method, params};
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      ws.send(JSON.stringify(req));
    });
  }

  /** 订阅某事件类型；返回退订函数。 */
  on(type: string, handler: EventHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  /** 订阅全部事件（含未知类型）。 */
  onAny(handler: EventHandler): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  private dispatch(evt: GatewayEventFrame['params']) {
    const set = this.handlers.get(evt.type);
    if (set) {
      for (const h of [...set]) {
        try {
          h(evt);
        } catch {
          // 单个 handler 异常不影响分发
        }
      }
    }
    for (const h of [...this.anyHandlers]) {
      try {
        h(evt);
      } catch {
        // ignore
      }
    }
  }
}
