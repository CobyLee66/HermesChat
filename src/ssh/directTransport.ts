/**
 * 直连 Transport：不经 SSH 隧道，WS/HTTP 直连已运行的 hermes gateway。
 * 适用：Android 原生（RN fetch/WS 无 CORS 限制，manifest 已允许明文流量）。
 * 桌面（Electron）经主进程回环代理，见 desktopBridge.ts 的 DesktopDirectTransport；
 * 浏览器受 CORS/Host/Origin 限制走 vite 代理，见 webDirect.ts。
 *
 * token 获取对应 docs/ssh-module.md §3.6 兜底：配置里手动填写，留空则
 * GET gateway 首页 SPA HTML 提取 __HERMES_SESSION_TOKEN__（与 SSH 隧道
 * 复用 extractToken 同一机制）。每次 connect 重新提取——gateway 重启换
 * token 后重连天然兼容。
 */

import {extractToken, type Transport, type TransportResult} from './transport';
import {t} from '../i18n';

export interface DirectConfig {
  host: string;
  port: number;
  /** 手动 session token；留空自动提取 */
  token?: string;
}

export class DirectTransport implements Transport {
  onDrop?: () => void;

  constructor(private cfg: DirectConfig) {}

  async connect(): Promise<TransportResult> {
    const httpUrl = `http://${this.cfg.host}:${this.cfg.port}`;
    let token = this.cfg.token ?? '';
    if (!token) {
      token = await this.fetchToken(httpUrl);
    }
    if (!token) {
      throw new Error(t('ssh.tokenExtractFail'));
    }
    return {
      wsUrl: `ws://${this.cfg.host}:${this.cfg.port}/api/ws?token=${encodeURIComponent(token)}`,
      httpUrl,
      token,
    };
  }

  /**
   * RN fetch 默认永不超时（D018 教训），黑洞地址会永久挂起 UI——
   * AbortController 10s 兜底。
   */
  private async fetchToken(httpUrl: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const resp = await fetch(httpUrl, {signal: controller.signal});
      if (!resp.ok) {
        throw new Error(t('ssh.gatewayHttp', {status: resp.status}));
      }
      return extractToken(await resp.text()) ?? '';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(t('ssh.gatewayUnreachable', {url: httpUrl, message: msg}));
    } finally {
      clearTimeout(timer);
    }
  }

  async disconnect(): Promise<void> {
    // 无隧道/转发资源需要释放
  }
}
