/**
 * 连接状态机：disconnected → connecting → bootstrapping → ready → reconnecting
 * 配置 AsyncStorage 持久化（含私钥/口令，App 沙盒内）；密码仅存内存。
 * 重连：指数退避 1s→30s（backoffDelay），断线后重建隧道+WS 由 connector 完成，
 * 成功后被活跃会话 session.resume。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {create} from 'zustand';

import type {RpcClient} from '../rpc/client';
import {setRpc} from '../rpc/runtime';
import {useChatStore} from './chat';
import {useSessionsStore} from './sessions';

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'bootstrapping'
  | 'ready'
  | 'reconnecting';

export interface SshFormConfig {
  /** true = 开发直连（默认 127.0.0.1:9119），false = SSH 隧道 */
  direct: boolean;
  directHost: string;
  directPort: string;
  /** 手填 token（兜底，仅内存） */
  directToken: string;
  host: string;
  port: string;
  username: string;
  /** 仅存内存，不持久化 */
  password: string;
  /** 持久化于 App 沙盒（用户要求记住上次选择的密钥，避免每次重选） */
  privateKey: string;
  passphrase: string;
  /** 上次选择的密钥文件名（仅显示用，随私钥一起持久化） */
  keyFileName: string;
}

export const DEFAULT_CONFIG: SshFormConfig = {
  direct: true,
  directHost: '127.0.0.1',
  directPort: '9119',
  directToken: '',
  host: '',
  port: '22',
  username: '',
  password: '',
  privateKey: '',
  passphrase: '',
  keyFileName: '',
};

const STORAGE_KEY = 'hermes.connection.v1';

/** 指数退避：1s → 2s → 4s … 封顶 30s。attempt 从 0 起。 */
export function backoffDelay(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt), 30000);
}

export interface ConnectResult {
  rpc: RpcClient;
  wsUrl: string;
  httpUrl: string;
  token?: string;
}

/** 连接引擎接口（生产实现 = SshManager；测试可注入 mock）。 */
export interface Connector {
  connect(cfg: SshFormConfig): Promise<ConnectResult>;
  disconnect(): Promise<void>;
  /** 注册意外断开回调（隧道掉线/WS 断开） */
  onDrop(cb: (reason: string) => void): void;
  /** 重连成功后对活跃会话 session.resume */
  resumeActiveSessions(): Promise<void>;
}

interface ConnectionStore {
  state: ConnectionState;
  error: string | null;
  wsUrl: string;
  httpUrl: string;
  token: string;
  config: SshFormConfig;
  reconnectAttempt: number;
  connector: Connector | null;

  setConnector(c: Connector): void;
  setConfig(patch: Partial<SshFormConfig>): void;
  loadPersisted(): Promise<void>;
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;
  handleDrop(reason: string): void;
  /** 回前台等场景：立即重试（重置退避计数）。 */
  retryNow(): void;
}

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

/** 连接成功后的事件总线接线：session 事件 → chat store，全局事件 → sessions store。 */
function wireEvents(rpc: RpcClient) {
  rpc.onAny(evt => {
    if (evt.type === 'sessions.changed') {
      useSessionsStore.getState().markStale();
      return;
    }
    if (evt.session_id) {
      useChatStore
        .getState()
        .applyEvent(evt.session_id, evt.type, evt.payload);
    }
  });
}

export const useConnectionStore = create<ConnectionStore>((set, get) => {
  async function connectInternal(): Promise<boolean> {
    const {config, connector} = get();
    if (!connector) {
      set({state: 'disconnected', error: 'connector 未初始化'});
      return false;
    }
    const result = await connector.connect(config);
    set({state: 'bootstrapping', error: null});
    wireEvents(result.rpc);
    setRpc(result.rpc);
    set({
      state: 'ready',
      wsUrl: result.wsUrl,
      httpUrl: result.httpUrl,
      token: result.token ?? '',
      reconnectAttempt: 0,
    });
    // 引导数据（失败不阻塞 ready）
    useSessionsStore.getState().markStale();
    return true;
  }

  function scheduleReconnect() {
    clearReconnectTimer();
    const attempt = get().reconnectAttempt;
    const delay = backoffDelay(attempt);
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      const connector = get().connector;
      if (!connector || get().state !== 'reconnecting') {
        return;
      }
      try {
        const ok = await connectInternal();
        if (ok) {
          try {
            await connector.resumeActiveSessions();
          } catch {
            // resume 失败不致命：用户可手动重进会话
          }
        }
      } catch (e) {
        set({
          state: 'reconnecting',
          reconnectAttempt: get().reconnectAttempt + 1,
          error: e instanceof Error ? e.message : String(e),
        });
        scheduleReconnect();
      }
    }, delay);
  }

  return {
    state: 'disconnected',
    error: null,
    wsUrl: '',
    httpUrl: '',
    token: '',
    config: DEFAULT_CONFIG,
    reconnectAttempt: 0,
    connector: null,

    setConnector(c) {
      set({connector: c});
      c.onDrop(reason => get().handleDrop(reason));
    },

    setConfig(patch) {
      const next = {...get().config, ...patch};
      set({config: next});
      // 密码仅存内存；私钥/口令/密钥文件名持久化（App 沙盒内，用户明确要求）
      const safe: Partial<SshFormConfig> = {
        direct: next.direct,
        directHost: next.directHost,
        directPort: next.directPort,
        host: next.host,
        port: next.port,
        username: next.username,
        privateKey: next.privateKey,
        passphrase: next.passphrase,
        keyFileName: next.keyFileName,
      };
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(safe)).catch(() => {});
    },

    async loadPersisted() {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!raw) {
          return;
        }
        const saved = JSON.parse(raw) as Partial<SshFormConfig>;
        set({config: {...DEFAULT_CONFIG, ...saved}});
      } catch {
        // 损坏的持久化数据忽略
      }
    },

    async connect() {
      if (get().state === 'connecting' || get().state === 'bootstrapping') {
        return false;
      }
      clearReconnectTimer();
      set({state: 'connecting', error: null});
      try {
        return await connectInternal();
      } catch (e) {
        set({
          state: 'disconnected',
          error: e instanceof Error ? e.message : String(e),
        });
        return false;
      }
    },

    async disconnect() {
      clearReconnectTimer();
      const connector = get().connector;
      set({state: 'disconnected', error: null, reconnectAttempt: 0});
      setRpc(null);
      if (connector) {
        try {
          await connector.disconnect();
        } catch {
          // ignore
        }
      }
    },

    handleDrop(reason) {
      const st = get().state;
      if (st === 'disconnected' || st === 'reconnecting') {
        return;
      }
      setRpc(null);
      set({state: 'reconnecting', error: reason, reconnectAttempt: 0});
      scheduleReconnect();
    },

    retryNow() {
      if (get().state !== 'reconnecting') {
        return;
      }
      set({reconnectAttempt: 0});
      scheduleReconnect();
    },
  };
});

/** 测试辅助：复位模块级定时器。 */
export function _resetConnectionTimers() {
  clearReconnectTimer();
}
