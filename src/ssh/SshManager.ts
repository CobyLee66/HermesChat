/**
 * SshManager：连接引擎（实现 connection store 的 Connector 接口）。
 * - transport 生命周期（SshTunnel）
 * - RpcClient 建立与断开回调
 * - AppState 监听：回前台时若处于 reconnecting，立即重试（重置退避）
 * - 重连成功后对活跃会话 session.resume
 *
 * 重连调度（指数退避 1s→30s）在 connection store（backoffDelay），
 * 这里负责"怎么连"与"连上之后恢复什么"。
 */

import {AppState, type AppStateStatus} from 'react-native';

import {RpcClient} from '../rpc/client';
import type {SessionResumeResult} from '../rpc/types';
import type {
  ConnectResult,
  Connector,
  ConnectionProfile,
} from '../store/connection';
import {useChatStore} from '../store/chat';
import type {ExecRemoteFn} from './execRemote';
import * as HermesSsh from './HermesSsh';
import {SshTunnelTransport, type Transport} from './transport';

/** transport 工厂：默认 SSH 隧道；web 直连注入 WebDirectTransport（见 ssh/webDirect.ts）。 */
export type TransportFactory = (cfg: ConnectionProfile) => Transport;

const defaultTransportFactory: TransportFactory = cfg =>
  new SshTunnelTransport({
    host: cfg.host,
    port: parseInt(cfg.port, 10) || 22,
    username: cfg.username,
    password: cfg.password || undefined,
    privateKey: cfg.privateKey || undefined,
    passphrase: cfg.passphrase || undefined,
  });

export class SshManager implements Connector {
  private transport: Transport | null = null;
  private rpc: RpcClient | null = null;
  private dropCb: ((reason: string) => void) | null = null;
  private foregroundCb: (() => void) | null = null;
  private transportFactory: TransportFactory;
  private appStateSub: {remove(): void} | null = null;
  /** 手动 disconnect 期间抑制 drop 上报 */
  private tearingDown = false;
  /**
   * 远端只读 exec（multiplex 归属扫描/历史查询用）。
   * 仅 SSH 原生模块可用时提供（web 直连的 WebDirectTransport 无隧道层）。
   */
  readonly execRemote?: ExecRemoteFn;

  /** onForeground：App 回前台时调用（connection store 用来立即重试）。 */
  constructor(opts?: {
    onForeground?: () => void;
    transportFactory?: TransportFactory;
  }) {
    this.foregroundCb = opts?.onForeground ?? null;
    this.transportFactory = opts?.transportFactory ?? defaultTransportFactory;
    if (HermesSsh.isAvailable) {
      this.execRemote = (command, timeoutMs) =>
        HermesSsh.exec(command, timeoutMs ?? HermesSsh.DEFAULT_EXEC_TIMEOUT_MS);
    }
    this.appStateSub = AppState.addEventListener(
      'change',
      (s: AppStateStatus) => {
        if (s === 'active') {
          this.foregroundCb?.();
        }
      },
    );
  }

  onDrop(cb: (reason: string) => void): void {
    this.dropCb = cb;
  }

  private reportDrop(reason: string) {
    if (!this.tearingDown && this.dropCb) {
      this.dropCb(reason);
    }
  }

  async connect(cfg: ConnectionProfile): Promise<ConnectResult> {
    this.tearingDown = false;
    // 先清理旧实例（重连路径）
    await this.teardownTransport();

    const transport: Transport = this.transportFactory(cfg);
    transport.onDrop = () => this.reportDrop('transport dropped');
    this.transport = transport;

    const {wsUrl, httpUrl, token} = await transport.connect();

    const rpc = new RpcClient({
      onClose: reason => this.reportDrop(reason),
    });
    await rpc.connect(wsUrl);
    this.rpc = rpc;
    return {rpc, wsUrl, httpUrl, token};
  }

  /** 断线重建后对 chat store 里仍有内容的会话做 session.resume。 */
  async resumeActiveSessions(): Promise<void> {
    const rpc = this.rpc;
    if (!rpc || !rpc.isOpen) {
      return;
    }
    const chat = useChatStore.getState();
    for (const [sid, state] of Object.entries(chat.bySession)) {
      // foreign 只读视图（物理在其它 profile 的库，本就不能 resume 到当前
      // profile）与已派生迁移的残留条目跳过重挂
      if (state.foreign || state.migratedTo) {
        continue;
      }
      const profile = state.profile;
      const storedId = state.storedSessionId || sid;
      try {
        const result = await rpc.call<SessionResumeResult>('session.resume', {
          session_id: storedId,
          profile,
          cols: 100,
        });
        const liveSid = result?.session_id || sid;
        // resume 返回历史 + 断线期间挂起的审批/澄清（事件单播给旧
        // transport，错过只能靠 pending_* 恢复）：重挂到原 key 或迁移新 key
        chat.reattachAfterResume(sid, liveSid, {
          messages: result?.messages ?? [],
          running: result?.running,
          inflight: result?.inflight,
          pendingApprovals: result?.pending_approval,
          pendingClarifies: result?.pending_clarify,
        });
      } catch {
        // 单个会话恢复失败不阻塞其他会话（服务端可能已回收）
        chat.markResumeFailed(sid);
      }
    }
  }

  async disconnect(): Promise<void> {
    this.tearingDown = true;
    const rpc = this.rpc;
    this.rpc = null;
    rpc?.disconnect();
    await this.teardownTransport();
  }

  private async teardownTransport() {
    const t = this.transport;
    this.transport = null;
    if (t) {
      t.onDrop = undefined;
      try {
        await t.disconnect();
      } catch {
        // ignore
      }
    }
  }

  dispose() {
    this.appStateSub?.remove();
    this.appStateSub = null;
  }
}

/** 生产连接器单例。onForeground 由 initConnectionEngine 注入 retryNow。 */
let instance: SshManager | null = null;

export function getSshManager(opts?: {onForeground?: () => void}): SshManager {
  if (!instance) {
    instance = new SshManager(opts);
  }
  return instance;
}

/** App 启动时装配一次：SshManager 注册为 connection store 的 connector。 */
export function initConnectionEngine(): void {
  // 延迟 require 避免模块加载期环依赖（connection ↔ SshManager 仅此处交汇）
  const {useConnectionStore} =
    require('../store/connection') as typeof import('../store/connection');
  const conn = useConnectionStore.getState();
  if (!conn.connector) {
    conn.setConnector(
      getSshManager({
        onForeground: () => useConnectionStore.getState().retryNow(),
      }),
    );
  }
}
