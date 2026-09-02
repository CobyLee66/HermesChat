/**
 * 连接状态机：disconnected → connecting → bootstrapping → ready → reconnecting
 * 多 SSH 配置（ConnectionProfile）全字段 AsyncStorage 持久化——含密码/私钥/口令，
 * 存于 App 沙盒内（用户明确要求记住凭据、点卡片一键直连）。
 * 重连：指数退避 1s→30s（backoffDelay），断线后重建隧道+WS 由 connector 完成，
 * 成功后被活跃会话 session.resume。重连始终使用 currentProfileId 指向的配置。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {create} from 'zustand';

import type {RpcClient} from '../rpc/client';
import {hasRpc, setRpc} from '../rpc/runtime';
import {setExecRemote, type ExecRemoteFn} from '../ssh/execRemote';
import {useChatStore} from './chat';
import {useSessionsStore} from './sessions';

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'bootstrapping'
  | 'ready'
  | 'reconnecting';

export interface ConnectionProfile {
  /** 本地生成（genProfileId） */
  id: string;
  /** 配置名称（卡片显示） */
  name: string;
  host: string;
  port: string;
  username: string;
  /** 持久化于 App 沙盒（用户明确要求一键直连，免每次输入） */
  password: string;
  /** 持久化于 App 沙盒 */
  privateKey: string;
  passphrase: string;
  /** 上次选择的密钥文件名（仅显示用，随私钥一起持久化） */
  keyFileName: string;
}

/** 新增配置的初始表单值。 */
export const EMPTY_PROFILE: Omit<ConnectionProfile, 'id'> = {
  name: '',
  host: '',
  port: '22',
  username: '',
  password: '',
  privateKey: '',
  passphrase: '',
  keyFileName: '',
};

/**
 * 本地 id 生成器（不引新依赖）：时间戳 + 随机段。
 * 本机配置表内足够唯一，无需 nanoid。
 */
export function genProfileId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export const STORAGE_KEY = 'hermes.connections.v2';

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
  connect(cfg: ConnectionProfile): Promise<ConnectResult>;
  disconnect(): Promise<void>;
  /** 注册意外断开回调（隧道掉线/WS 断开） */
  onDrop(cb: (reason: string) => void): void;
  /** 重连成功后对活跃会话 session.resume */
  resumeActiveSessions(): Promise<void>;
  /**
   * 远端只读 exec（SSH 隧道可用时由 SshManager 提供；web 直连为 undefined）。
   * 连接成功后由 connection store 注册到 ssh/execRemote 注册表。
   */
  execRemote?: ExecRemoteFn;
}

interface ConnectionStore {
  state: ConnectionState;
  error: string | null;
  wsUrl: string;
  httpUrl: string;
  token: string;
  /** 全部 SSH 配置 */
  profiles: ConnectionProfile[];
  /** 当前连接使用的配置（重连也用它） */
  currentProfileId: string | null;
  /** "打开应用后自动连接"的配置（全局最多一个） */
  autoProfileId: string | null;
  reconnectAttempt: number;
  connector: Connector | null;

  setConnector(c: Connector): void;
  addProfile(input: Omit<ConnectionProfile, 'id'>): ConnectionProfile;
  updateProfile(
    id: string,
    patch: Partial<Omit<ConnectionProfile, 'id'>>,
  ): void;
  removeProfile(id: string): void;
  /** 设新的自动连接配置（自动顶替旧的）；传 null 取消 */
  setAutoProfile(id: string | null): void;
  loadPersisted(): Promise<void>;
  /** 连接指定配置（缺省用 currentProfileId） */
  connect(profileId?: string): Promise<boolean>;
  disconnect(): Promise<void>;
  handleDrop(reason: string): void;
  /** 回前台等场景：立即重试（重置退避计数）。 */
  retryNow(): void;
  /** 等待连接就绪（重连中先立即触发一次重试）；已断开或超时则抛错。 */
  waitReady(timeoutMs?: number): Promise<void>;
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
  /** 全字段持久化（含密码/私钥，App 沙盒内；用户明确要求）。 */
  function persist() {
    const {profiles, currentProfileId, autoProfileId} = get();
    AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({profiles, currentProfileId, autoProfileId}),
    ).catch(() => {});
  }

  async function connectInternal(): Promise<boolean> {
    const {profiles, currentProfileId, connector} = get();
    if (!connector) {
      set({state: 'disconnected', error: 'connector 未初始化'});
      return false;
    }
    const profile = profiles.find(p => p.id === currentProfileId);
    if (!profile) {
      set({state: 'disconnected', error: '未找到当前连接配置'});
      return false;
    }
    const result = await connector.connect(profile);
    set({state: 'bootstrapping', error: null});
    wireEvents(result.rpc);
    setRpc(result.rpc);
    // 只读 exec 能力（multiplex 归属扫描用）；web 直连时为 undefined → null
    setExecRemote(connector.execRemote ?? null);
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
    profiles: [],
    currentProfileId: null,
    autoProfileId: null,
    reconnectAttempt: 0,
    connector: null,

    setConnector(c) {
      set({connector: c});
      c.onDrop(reason => get().handleDrop(reason));
    },

    addProfile(input) {
      const profile: ConnectionProfile = {...input, id: genProfileId()};
      set({profiles: [...get().profiles, profile]});
      persist();
      return profile;
    },

    updateProfile(id, patch) {
      set({
        profiles: get().profiles.map(p => (p.id === id ? {...p, ...patch} : p)),
      });
      persist();
    },

    removeProfile(id) {
      const {profiles, currentProfileId, autoProfileId} = get();
      set({
        profiles: profiles.filter(p => p.id !== id),
        currentProfileId: currentProfileId === id ? null : currentProfileId,
        autoProfileId: autoProfileId === id ? null : autoProfileId,
      });
      persist();
    },

    setAutoProfile(id) {
      // 单字段即天然唯一：赋新值自动顶替旧值
      set({autoProfileId: id});
      persist();
    },

    async loadPersisted() {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!raw) {
          return;
        }
        const saved = JSON.parse(raw) as {
          profiles?: ConnectionProfile[];
          currentProfileId?: string | null;
          autoProfileId?: string | null;
        };
        set({
          profiles: saved.profiles ?? [],
          currentProfileId: saved.currentProfileId ?? null,
          autoProfileId: saved.autoProfileId ?? null,
        });
      } catch {
        // 损坏的持久化数据忽略
      }
    },

    async connect(profileId) {
      if (profileId) {
        set({currentProfileId: profileId});
        persist();
      }
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
      setExecRemote(null);
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
      setExecRemote(null);
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

    async waitReady(timeoutMs = 15000) {
      if (get().state === 'ready' && hasRpc()) {
        return;
      }
      if (get().state === 'disconnected') {
        throw new Error('未连接');
      }
      // 重连中：立即触发一次重试，不傻等退避计时
      get().retryNow();
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (get().state === 'ready' && hasRpc()) {
          return;
        }
        if (Date.now() >= deadline) {
          throw new Error('连接恢复超时，请稍后重试');
        }
        await new Promise<void>(r => setTimeout(r, 200));
      }
    },
  };
});

/** 测试辅助：复位模块级定时器。 */
export function _resetConnectionTimers() {
  clearReconnectTimer();
}
