/**
 * Transport 抽象（docs/ssh-module.md §5）。
 * 仅 SshTunnelTransport：走 docs/ssh-module.md §3 bootstrap 流程。
 * （开发直连 DirectWsTransport 已随多配置重构移除。）
 */

import * as HermesSsh from './HermesSsh';
import type {SshConfig} from './HermesSsh';
import {t} from '../i18n';

export type {SshConfig} from './HermesSsh';

export interface TransportResult {
  wsUrl: string;
  httpUrl: string;
  token?: string;
}

export interface Transport {
  connect(): Promise<TransportResult>;
  disconnect(): Promise<void>;
  /** 意外断开回调 */
  onDrop?: () => void;
}

/** 从 SPA HTML 提取 session token。 */
export function extractToken(html: string): string | null {
  const m = html.match(/__HERMES_SESSION_TOKEN__="([^"]+)"/);
  return m ? m[1] : null;
}

function randomToken(): string {
  // 16 字节随机 hex；RN 无 crypto.getRandomValues 时的简易实现足够（仅会话令牌）
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return s;
}

// ─── SshTunnelTransport（生产） ─────────────────────────────────
//
// 消费 ./HermesSsh（docs/ssh-module.md §2 契约的 typed wrapper），
// bootstrap 流程按 §3：connect → exec 探测 → 复用 9119 或 startCommand 拉起
// 解析 HERMES_BACKEND_READY → openLocalForward。

export class SshTunnelTransport implements Transport {
  onDrop?: () => void;

  private localPort: number | null = null;
  private serveTaskId: string | null = null;
  private unsubs: (() => void)[] = [];

  constructor(private cfg: SshConfig) {}

  async connect(): Promise<TransportResult> {
    if (!HermesSsh.isAvailable) {
      throw new Error(t('ssh.moduleUnavailable'));
    }

    // 非主动断开 → 通知上层（重建隧道 + WS）
    this.unsubs.push(HermesSsh.onDisconnect(() => this.onDrop?.()));

    // §3.1 connect
    await HermesSsh.connect({
      host: this.cfg.host,
      port: this.cfg.port || 22,
      username: this.cfg.username,
      password: this.cfg.password,
      privateKey: this.cfg.privateKey,
      passphrase: this.cfg.passphrase,
    });

    // §3.2 解析 hermes 可执行文件路径
    // 非交互 SSH exec 不加载用户 shell 配置（~/.zshrc 等），PATH 里没有 hermes 是常态，
    // 必须兜底登录 shell 和常见安装目录。
    const hermesBin = await this.resolveHermesBin();

    let remotePort: number | null = null;
    let token = '';

    // §3.3 复用优先：9119 已有实例
    const health = await HermesSsh.exec('curl -s -m 2 http://127.0.0.1:9119/api/health', 5000);
    if (health.exitCode === 0 && health.stdout.trim()) {
      remotePort = 9119;
      const tk = await HermesSsh.exec(
        `curl -s http://127.0.0.1:9119/ | grep -oE '__HERMES_SESSION_TOKEN__="[^"]+"'`,
        5000,
      );
      token = extractToken(tk.stdout) ?? '';
    }

    // §3.4 否则拉起新的 hermes serve
    if (remotePort === null) {
      token = randomToken();
      const {taskId} = await HermesSsh.startCommand(
        `HERMES_DASHBOARD_SESSION_TOKEN=${token} "${hermesBin}" serve --isolated --host 127.0.0.1 --port 0`,
      );
      this.serveTaskId = taskId;
      remotePort = await this.waitReadyPort(taskId, 30000);
    }

    if (!token) {
      throw new Error(t('ssh.tokenNotFound'));
    }

    // §3.5 本地端口转发
    const {localPort} = await HermesSsh.openLocalForward(remotePort);
    this.localPort = localPort;
    const httpUrl = `http://127.0.0.1:${localPort}`;
    return {
      wsUrl: `ws://127.0.0.1:${localPort}/api/ws?token=${encodeURIComponent(token)}`,
      httpUrl,
      token,
    };
  }

  /** 解析远端 hermes 可执行文件绝对路径（见 §3.2 注释：非交互 SSH 无用户 PATH）。 */
  private async resolveHermesBin(): Promise<string> {
    const probe = await HermesSsh.exec(
      '(command -v hermes || zsh -lc "command -v hermes" 2>/dev/null ||' +
        ' bash -lc "command -v hermes" 2>/dev/null ||' +
        ' ls -1 ~/.local/bin/hermes ~/.hermes/bin/hermes /usr/local/bin/hermes' +
        ' /opt/homebrew/bin/hermes 2>/dev/null) | head -1',
      15000,
    );
    const bin = probe.stdout.trim().split('\n')[0]?.trim() ?? '';
    if (!bin) {
      throw new Error(t('ssh.hermesNotFound'));
    }
    return bin;
  }

  /** 从 startCommand 的 stdout 行事件解析 HERMES_BACKEND_READY port=<n>。 */
  private waitReadyPort(taskId: string, timeoutMs: number): Promise<number> {
    return new Promise((resolve, reject) => {
      let buffer = '';
      let done = false;
      const finish = (fn: () => void) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        unsubOut();
        unsubExit();
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error(t('ssh.readyTimeout')))),
        timeoutMs,
      );
      const unsubOut = HermesSsh.onStdout(taskId, line => {
        buffer += line + '\n';
        const m = buffer.match(/HERMES_BACKEND_READY port=(\d+)/);
        if (m) {
          const port = parseInt(m[1], 10);
          finish(() => resolve(port));
        }
      });
      const unsubExit = HermesSsh.onExit(taskId, exitCode =>
        finish(() =>
          reject(
            new Error(
              t('ssh.serveExited', {
                code: exitCode,
                tail: buffer.slice(-500),
              }),
            ),
          ),
        ),
      );
      this.unsubs.push(unsubOut, unsubExit);
    });
  }

  async disconnect(): Promise<void> {
    for (const unsub of this.unsubs.splice(0)) {
      unsub();
    }
    if (!HermesSsh.isAvailable) {
      return;
    }
    if (this.serveTaskId) {
      try {
        await HermesSsh.stopCommand(this.serveTaskId);
      } catch {
        // ignore
      }
      this.serveTaskId = null;
    }
    if (this.localPort !== null) {
      try {
        await HermesSsh.closeLocalForward(this.localPort);
      } catch {
        // ignore
      }
      this.localPort = null;
    }
    try {
      await HermesSsh.disconnect();
    } catch {
      // ignore
    }
  }
}
