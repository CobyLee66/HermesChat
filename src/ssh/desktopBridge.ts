/**
 * desktopBridge — 桌面壳（Electron）连接引擎装配。
 *
 * 隧道 bootstrap（解析 hermes 路径 → 复用 9119 / 拉起 serve → openLocalForward）
 * 复用 SshTunnelTransport 单源实现：web 构建中它消费的 './HermesSsh' 被 vite
 * alias 到 desktopHermesSsh（window.hermesDesktop → 主进程 ssh2）。
 *
 * 桌面唯一差异：渲染层与 /api 必须走主进程回环代理（Host/Origin 重写绕过
 * hermes web_server 的 DNS-rebinding 防护，与 vite dev proxy 同策略），所以
 * connect() 后把 wsUrl/httpUrl 改写为渲染层 origin 的同源相对地址。
 * 直连模式（DesktopDirectTransport）同理：代理上游由隧道本地端口换成
 * gateway 地址本身，token 由主进程代取。
 */

import type {ConnectionProfile} from '../store/connection';
import {useConnectionStore} from '../store/connection';
import {t} from '../i18n';
import {SshManager} from './SshManager';
import {getDesktopBridge, hasDesktopBridge} from './desktopHermesSsh';
import {SshTunnelTransport, type SshConfig, type Transport, type TransportResult} from './transport';

export {hasDesktopBridge} from './desktopHermesSsh';

/** 桌面 Transport：隧道逻辑复用 SshTunnelTransport，仅改写产物 URL 为同源。 */
export class DesktopSshTransport implements Transport {
  onDrop?: () => void;

  private inner: SshTunnelTransport;

  constructor(cfg: SshConfig) {
    this.inner = new SshTunnelTransport(cfg);
  }

  async connect(): Promise<TransportResult> {
    if (!hasDesktopBridge()) {
      throw new Error(t('ssh.desktopBridgeUnavailable'));
    }
    this.inner.onDrop = () => this.onDrop?.();
    const result = await this.inner.connect();
    const loc = (globalThis as {location?: {protocol: string; host: string; origin: string}})
      .location;
    if (!loc) {
      throw new Error(t('ssh.noWindowLocation'));
    }
    const wsScheme = loc.protocol === 'https:' ? 'wss' : 'ws';
    return {
      // 经主进程回环代理：/api/** 与 /api/ws upgrade 由代理转发到隧道端口
      wsUrl: `${wsScheme}://${loc.host}/api/ws?token=${encodeURIComponent(
        result.token ?? '',
      )}`,
      httpUrl: loc.origin,
      token: result.token,
    };
  }

  async disconnect(): Promise<void> {
    await this.inner.disconnect();
  }
}

/** 桌面直连 Transport：主进程代取 token + 代理上游=gateway，产物 URL 改写为同源。 */
export class DesktopDirectTransport implements Transport {
  onDrop?: () => void;

  constructor(
    private cfg: {host: string; port: number; token?: string},
  ) {}

  async connect(): Promise<TransportResult> {
    const bridge = getDesktopBridge();
    if (!bridge) {
      throw new Error(t('ssh.bridgeUnavailableShort'));
    }
    // 主进程记录代理上游 + 提取 token（渲染层与 gateway 跨源，fetch 不可靠）
    const {token} = await bridge.directConnect({
      host: this.cfg.host,
      port: this.cfg.port,
      token: this.cfg.token || undefined,
    });
    const loc = (
      globalThis as {location?: {protocol: string; host: string; origin: string}}
    ).location;
    if (!loc) {
      throw new Error(t('ssh.noWindowLocation'));
    }
    const wsScheme = loc.protocol === 'https:' ? 'wss' : 'ws';
    return {
      // /api/** 与 /api/ws upgrade 由主进程代理转发到 gateway
      wsUrl: `${wsScheme}://${loc.host}/api/ws?token=${encodeURIComponent(token)}`,
      httpUrl: loc.origin,
      token,
    };
  }

  async disconnect(): Promise<void> {
    const bridge = getDesktopBridge();
    if (!bridge) {
      return;
    }
    try {
      await bridge.directDisconnect();
    } catch {
      // ignore
    }
  }
}

/** SshManager 的 transportFactory：按配置类型分发（SSH 隧道 / 直连）。 */
export function desktopTransportFactory(cfg: ConnectionProfile): Transport {
  if (cfg.type === 'direct') {
    return new DesktopDirectTransport({
      host: cfg.host,
      port: parseInt(cfg.port, 10) || 9119,
      token: cfg.token || undefined,
    });
  }
  return new DesktopSshTransport({
    host: cfg.host,
    port: parseInt(cfg.port, 10) || 22,
    username: cfg.username,
    password: cfg.password || undefined,
    privateKey: cfg.privateKey || undefined,
    passphrase: cfg.passphrase || undefined,
  });
}

/**
 * App 装配（仅 Electron 桌面）：连接引擎 = SshManager + DesktopSshTransport 工厂。
 * 复用 SshManager 的断线上报/重连/session.resume；execRemote 因桌面桥
 * isAvailable=true 自动启用（multiplex 归属扫描 / foreign 只读历史可用）。
 */
export function initDesktopEngine(): void {
  const conn = useConnectionStore.getState();
  if (!conn.connector) {
    conn.setConnector(
      new SshManager({
        transportFactory: desktopTransportFactory,
        onForeground: () => useConnectionStore.getState().handleForeground(),
      }),
    );
  }
}
