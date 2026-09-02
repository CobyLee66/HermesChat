/**
 * web 专用：浏览器直连本机 dashboard（127.0.0.1:9119）。
 * 仅 Platform.OS === 'web' 时由 App/连接主页调用；手机端不会走这条路径。
 *
 * 通道（依赖 vite server.proxy，见 vite.config.ts）：
 * - HTTP GET /__hermes/ → 代理到 dashboard 首页 SPA，提取 __HERMES_SESSION_TOKEN__
 *   （与 src/ssh/transport.ts 的 extractToken 同一逻辑）。
 * - WS /api/ws?token=… → 同源相对地址，经 vite 代理 upgrade；代理已把
 *   Host/Origin 重写为 127.0.0.1:9119，绕过 web_server 的 DNS-rebinding 防护。
 * - 其余 /api/**（文件下载、语音转写）同理同源代理。
 */

import {Platform} from 'react-native';

import {useConnectionStore} from '../store/connection';
import {SshManager} from './SshManager';
import {extractToken, type Transport, type TransportResult} from './transport';

/** 伪配置的 host 标记（区分真实 SSH 配置，避免误连） */
const DIRECT_HOST = 'web-direct';
export const WEB_DIRECT_NAME = '浏览器直连（本机 127.0.0.1:9119）';

interface WebLocation {
  origin: string;
  host: string;
  protocol: string;
}

function webLocation(): WebLocation {
  if (Platform.OS !== 'web') {
    throw new Error('浏览器直连仅在 web 构建中可用');
  }
  const loc = (globalThis as {location?: WebLocation}).location;
  if (!loc) {
    throw new Error('浏览器直连需要 window.location');
  }
  return loc;
}

/** web 直连 Transport：无 SSH 隧道，WS/HTTP 均走 vite 代理的同源相对路径。 */
export class WebDirectTransport implements Transport {
  /** 无隧道层，意外断开由 RpcClient.onClose 上报，这里不触发 onDrop */
  onDrop?: () => void;

  async connect(): Promise<TransportResult> {
    const loc = webLocation();
    const resp = await fetch(`${loc.origin}/__hermes/`);
    if (!resp.ok) {
      throw new Error(`获取 dashboard 页面失败（HTTP ${resp.status}）`);
    }
    const token = extractToken(await resp.text());
    if (!token) {
      throw new Error('未能从 dashboard 页面提取 session token');
    }
    const wsScheme = loc.protocol === 'https:' ? 'wss' : 'ws';
    return {
      wsUrl: `${wsScheme}://${loc.host}/api/ws?token=${encodeURIComponent(token)}`,
      httpUrl: loc.origin,
      token,
    };
  }

  async disconnect(): Promise<void> {
    // 无隧道/转发资源需要释放
  }
}

/** SshManager 的 transportFactory：仅放行直连伪配置，拒绝真实 SSH 配置。 */
export function webDirectTransportFactory(cfg: {host: string}): Transport {
  if (cfg.host !== DIRECT_HOST) {
    throw new Error('浏览器环境不支持 SSH 隧道，请使用「浏览器直连」入口');
  }
  return new WebDirectTransport();
}

/**
 * App 装配（仅 web）：连接引擎换成 SshManager + WebDirectTransport 工厂。
 * 复用 SshManager 的断线上报/AppState 重试/session.resume 逻辑，只换传输层。
 */
export function initWebDirectEngine(): void {
  const conn = useConnectionStore.getState();
  if (!conn.connector) {
    conn.setConnector(
      new SshManager({
        transportFactory: webDirectTransportFactory,
        onForeground: () => useConnectionStore.getState().retryNow(),
      }),
    );
  }
}

/**
 * 连接主页「浏览器直连」入口：确保伪配置存在（幂等，复用同名配置），
 * 然后走 connection store 的常规 connect 流程。
 */
export async function connectWebDirect(): Promise<boolean> {
  const conn = useConnectionStore.getState();
  let id = conn.profiles.find(p => p.host === DIRECT_HOST)?.id;
  if (!id) {
    id = conn.addProfile({
      name: WEB_DIRECT_NAME,
      host: DIRECT_HOST,
      port: '9119',
      username: 'browser',
      password: '',
      privateKey: '',
      passphrase: '',
      keyFileName: '',
    }).id;
  }
  return conn.connect(id);
}
