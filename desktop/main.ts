/**
 * HermesChat 桌面壳主进程（Electron）。
 *
 * 职责：
 * 1. BrowserWindow：加载本进程回环服务（renderer 与 /api 同源，无 CORS）。
 * 2. 回环 HTTP/WS 服务：静态 dist-web + /api 反代到 SSH 隧道本地端口，
 *    Host/Origin 重写策略对齐 vite.config.ts 已验证的 hermes DNS-rebinding
 *    防护绕过方案（web_server 对 WS upgrade 校验 Host/Origin）。
 * 3. SSH 隧道（ssh2 实现）：与 docs/ssh-module.md §2/§6 契约同构——
 *    错误码、keepalive 15s×3、exec 8MiB 上限、stopCommand/closeLocalForward/
 *    disconnect 幂等、被杀 task exit=-1 且每 task 恰好一次、HostKey accept-new。
 *
 * 监听端口必须跨次启动稳定（renderer localStorage 以 origin 为键）：
 * 端口记忆在 userData/proxy-port.json，被占用时向后顺延并回写。
 */

import {app, BrowserWindow, dialog, ipcMain, Notification, session} from 'electron';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import {Client, type ClientChannel, type ConnectConfig} from 'ssh2';

// ─── 窗口状态记忆 ───────────────────────────────────────────────

const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 900;
const MIN_WIDTH = 720;
const MIN_HEIGHT = 520;

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

function readWindowState(): WindowState {
  try {
    const raw = fs.readFileSync(
      path.join(app.getPath('userData'), 'window-state.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw) as WindowState;
    if (
      typeof parsed.width === 'number' &&
      typeof parsed.height === 'number' &&
      parsed.width > 0 &&
      parsed.height > 0
    ) {
      return parsed;
    }
  } catch {
    // 首次启动无文件，用默认值
  }
  return {width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT};
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const bounds = win.getNormalBounds();
    fs.writeFileSync(
      path.join(app.getPath('userData'), 'window-state.json'),
      JSON.stringify(bounds),
      'utf8',
    );
  } catch {
    // 记忆失败不影响退出
  }
}

// ─── SSH 隧道（ssh2 实现，契约见 docs/ssh-module.md §2/§6） ──────

interface SshTask {
  id: string;
  stream: ClientChannel;
  killed: boolean;
  exitSent: boolean;
  lineBuffer: string;
}

interface ForwardEntry {
  server: net.Server;
  sockets: Set<net.Socket>;
}

const KEEPALIVE_INTERVAL_MS = 15_000; // 对齐 Android：ServerAliveInterval
const KEEPALIVE_COUNT_MAX = 3; // 对齐 Android：ServerAliveCountMax
const CONNECT_TIMEOUT_MS = 15_000; // 对齐 Android：connect 15s
const EXEC_STREAM_CAP = 8 * 1024 * 1024; // 对齐 Android：单流收集上限 8 MiB

const ssh = {
  client: null as Client | null,
  ready: false,
  /** 主动 disconnect / 重连替换期间为 true，抑制 disconnect 事件 */
  intentional: false,
  /** 连接建立后是否已向上报过断连（每次连接重置） */
  dropNotified: false,
  hostKey: null as string | null,
  /** HostKey 变更时的精确错误消息（hostVerifier 回调里捕获） */
  hostKeyMismatch: null as string | null,
  tasks: new Map<string, SshTask>(),
  forwards: new Map<number, ForwardEntry>(),
};

let mainWindow: BrowserWindow | null = null;

function sendSshEvent(payload: Record<string, unknown>): void {
  const win = mainWindow;
  if (win && !win.isDestroyed()) {
    win.webContents.send('ssh:event', payload);
  }
}

function readKnownHosts(): Record<string, string> {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(app.getPath('userData'), 'known-hosts.json'), 'utf8'),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeKnownHosts(map: Record<string, string>): void {
  try {
    fs.writeFileSync(
      path.join(app.getPath('userData'), 'known-hosts.json'),
      JSON.stringify(map, null, 2),
      'utf8',
    );
  } catch {
    // 持久化失败只影响下次 accept-new 判定
  }
}

function fingerprintOf(key: Buffer): string {
  return `SHA256:${crypto.createHash('sha256').update(key).digest('base64')}`;
}

/** 契约 §6：清空全部 task/forward，被杀 task 发一次 exit=-1。 */
function teardownSsh(): void {
  for (const entry of ssh.forwards.values()) {
    for (const sock of entry.sockets) {
      sock.destroy();
    }
    entry.server.close();
  }
  ssh.forwards.clear();
  for (const task of ssh.tasks.values()) {
    killTask(task);
  }
  ssh.tasks.clear();
  const client = ssh.client;
  ssh.client = null;
  ssh.ready = false;
  if (client) {
    try {
      client.end();
    } catch {
      // ignore
    }
  }
}

function killTask(task: SshTask): void {
  task.killed = true;
  if (!task.exitSent) {
    task.exitSent = true;
    sendSshEvent({kind: 'exit', exitCode: -1, taskId: task.id});
  }
  try {
    task.stream.close();
  } catch {
    // ignore
  }
}

function sshError(code: string, detail: string): Error {
  return new Error(`${code}: ${detail}`);
}

/** 非主动断开时向上发一次 disconnect（渲染层据此触发重连状态机）。 */
function notifyDropIfUnintended(): void {
  if (!ssh.intentional && ssh.ready && !ssh.dropNotified) {
    ssh.dropNotified = true;
    sendSshEvent({
      kind: 'disconnect',
      reason: 'connection lost (keepalive timeout or transport error)',
    });
  }
}

interface ConnectRequest {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

function sshConnect(cfg: ConnectRequest): Promise<{serverFingerprint: string}> {
  // 契约 §6：重复 connect 先静默断开旧会话（不触发 disconnect 事件）
  ssh.intentional = true;
  teardownSsh();
  ssh.intentional = false;
  ssh.dropNotified = false;
  ssh.hostKeyMismatch = null;
  ssh.hostKey = null;

  return new Promise((resolve, reject) => {
    const client = new Client();
    ssh.client = client;
    let settled = false;

    const fail = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      ssh.intentional = true;
      teardownSsh();
      ssh.intentional = false;
      reject(err);
    };

    client.on('error', (err: Error) => {
      if (settled) {
        return; // 已建立后的传输层错误走 close 分支上报断连
      }
      if (ssh.hostKeyMismatch) {
        fail(sshError('E_CONNECT_FAILED', ssh.hostKeyMismatch));
        return;
      }
      fail(sshError('E_CONNECT_FAILED', err.message));
    });

    client.on('close', () => {
      const wasReady = ssh.ready;
      if (ssh.client === client) {
        ssh.client = null;
        ssh.ready = false;
      }
      if (settled) {
        if (wasReady) {
          teardownSsh();
          notifyDropIfUnintended();
        }
        return;
      }
      fail(sshError('E_CONNECT_FAILED', 'connection closed during handshake'));
    });

    client.on('ready', () => {
      ssh.ready = true;
      settled = true;
      resolve({serverFingerprint: ssh.hostKey ?? ''});
    });

    // HostKey accept-new（契约 §6）：未知主机接受并持久化；密钥变更 fail closed
    const knownKey = `${cfg.host}:${cfg.port}`;
    const known = readKnownHosts();

    const connectConfig: ConnectConfig = {
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      readyTimeout: CONNECT_TIMEOUT_MS,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        const fp = fingerprintOf(key);
        const stored = known[knownKey];
        if (stored && stored !== fp) {
          ssh.hostKey = fp;
          ssh.hostKeyMismatch =
            `HostKey has been changed（远端 ${knownKey} 指纹 ${fp}，` +
            `本地记录 ${stored}）`;
          verify(false);
          return;
        }
        ssh.hostKey = fp;
        known[knownKey] = fp;
        writeKnownHosts(known);
        verify(true);
      },
    };
    if (cfg.privateKey) {
      connectConfig.privateKey = cfg.privateKey;
      if (cfg.passphrase) {
        connectConfig.passphrase = cfg.passphrase;
      }
    } else if (cfg.password) {
      connectConfig.password = cfg.password;
    } else {
      // 无凭据：交给 ssh2 默认行为（agent / ~/.ssh 默认密钥）
    }

    try {
      client.connect(connectConfig);
    } catch (err) {
      fail(sshError('E_CONNECT_FAILED', String(err)));
    }
  });
}

function requireReadyClient(): Client {
  if (!ssh.client || !ssh.ready) {
    throw sshError('E_NOT_CONNECTED', 'SSH 未连接');
  }
  return ssh.client;
}

function sshExec(command: string, timeoutMs: number): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  let client: Client;
  try {
    client = requireReadyClient();
  } catch (err) {
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    client.exec(command, (err, stream) => {
      if (err) {
        reject(sshError('E_EXEC_FAILED', err.message));
        return;
      }
      let stdout = '';
      let stderr = '';
      let stdoutFull = true;
      let stderrFull = true;

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          stream.close();
        } catch {
          // ignore
        }
        reject(
          sshError(
            'E_EXEC_TIMEOUT',
            `exec 超时（${timeoutMs}ms）：${command.slice(0, 80)}`,
          ),
        );
      }, timeoutMs);

      stream.on('data', (chunk: Buffer) => {
        if (stdout.length + chunk.length <= EXEC_STREAM_CAP) {
          stdout += chunk.toString('utf8');
        } else {
          stdoutFull = false; // 超限丢弃但继续排空（契约 §6）
        }
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length + chunk.length <= EXEC_STREAM_CAP) {
          stderr += chunk.toString('utf8');
        } else {
          stderrFull = false;
        }
      });
      stream.on('close', (code?: number | null, signal?: string | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        const truncated = stdoutFull && stderrFull ? '' : '（输出超过 8MiB 已截断）';
        resolve({
          stdout: stdout + (stdoutFull ? '' : truncated),
          stderr,
          exitCode: code ?? (signal ? -1 : 0),
        });
      });
    });
  });
}

function sshStartCommand(command: string): Promise<{taskId: string}> {
  let client: Client;
  try {
    client = requireReadyClient();
  } catch (err) {
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(sshError('E_CHANNEL_FAILED', err.message));
        return;
      }
      const taskId = crypto.randomUUID();
      const task: SshTask = {
        id: taskId,
        stream,
        killed: false,
        exitSent: false,
        lineBuffer: '',
      };
      ssh.tasks.set(taskId, task);

      stream.on('data', (chunk: Buffer) => {
        task.lineBuffer += chunk.toString('utf8');
        let idx: number;
        while ((idx = task.lineBuffer.indexOf('\n')) >= 0) {
          const line = task.lineBuffer.slice(0, idx);
          task.lineBuffer = task.lineBuffer.slice(idx + 1);
          sendSshEvent({kind: 'stdout', taskId, line});
        }
      });
      // 契约 §6：startCommand 的 stderr 排空丢弃，防止远端写满通道窗口
      stream.stderr.resume();

      stream.on('close', (code?: number | null) => {
        if (task.exitSent) {
          return;
        }
        task.exitSent = true;
        // 残留未换行的尾行先补发，保证 HERMES_BACKEND_READY 这类尾行不丢
        if (task.lineBuffer) {
          sendSshEvent({kind: 'stdout', taskId, line: task.lineBuffer});
          task.lineBuffer = '';
        }
        sendSshEvent({
          kind: 'exit',
          taskId,
          exitCode: task.killed ? -1 : (code ?? -1),
        });
        ssh.tasks.delete(taskId);
      });

      resolve({taskId});
    });
  });
}

function sshStopCommand(taskId: string): Promise<void> {
  const task = ssh.tasks.get(taskId);
  if (!task) {
    return Promise.resolve(); // 幂等（契约 §6）
  }
  task.killed = true;
  if (!task.exitSent) {
    task.exitSent = true;
    sendSshEvent({kind: 'exit', taskId, exitCode: -1});
  }
  try {
    task.stream.signal('KILL');
  } catch {
    // 部分服务器不支持 signal，close channel 等价杀进程（channel 生命周期=进程）
  }
  try {
    task.stream.close();
  } catch {
    // ignore
  }
  ssh.tasks.delete(taskId);
  return Promise.resolve();
}

function sshOpenLocalForward(remotePort: number): Promise<{localPort: number}> {
  let client: Client;
  try {
    client = requireReadyClient();
  } catch (err) {
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    // 契约 §6：绑定 127.0.0.1:0，由系统分配实际端口
    const server = net.createServer(sock => {
      client.forwardOut(
        '127.0.0.1',
        sock.remotePort ?? 0,
        '127.0.0.1',
        remotePort,
        (err, upstream) => {
          if (err) {
            sock.destroy();
            return;
          }
          const entry = ssh.forwards.get(serverLocalPort);
          if (entry) {
            entry.sockets.add(sock);
            entry.sockets.add(upstream as unknown as net.Socket);
          }
          sock.pipe(upstream).pipe(sock);
          const cleanup = () => {
            sock.destroy();
            upstream.close();
          };
          sock.on('error', cleanup);
          upstream.on('error', cleanup);
          sock.on('close', cleanup);
          upstream.on('close', cleanup);
        },
      );
    });

    let serverLocalPort = 0;
    server.on('error', err => {
      if (serverLocalPort === 0) {
        reject(sshError('E_FORWARD_FAILED', err.message));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        serverLocalPort = addr.port;
      }
      ssh.forwards.set(serverLocalPort, {server, sockets: new Set()});
      resolve({localPort: serverLocalPort});
    });
  });
}

function sshCloseLocalForward(localPort: number): Promise<void> {
  const entry = ssh.forwards.get(localPort);
  if (entry) {
    for (const sock of entry.sockets) {
      sock.destroy();
    }
    entry.server.close();
    ssh.forwards.delete(localPort);
  }
  return Promise.resolve(); // 幂等（契约 §6）
}

function sshDisconnect(): Promise<void> {
  ssh.intentional = true;
  teardownSsh();
  return Promise.resolve();
}

// ─── 回环代理（静态 dist-web + /api → 隧道端口） ─────────────────

/** 当前 SSH 隧道本地端口（openLocalForward 成功后更新，disconnect 后清空） */
let tunnelPort: number | null = null;

const STATIC_ROOT = path.join(app.getAppPath(), 'dist-web');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  let urlPath: string;
  try {
    urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  } catch {
    urlPath = '/';
  }
  if (urlPath === '/') {
    urlPath = '/index.html';
  }
  const filePath = path.normalize(path.join(STATIC_ROOT, urlPath));
  if (!filePath.startsWith(STATIC_ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA 兜底回 index.html（本应用单页，仅防御性保留）
      fs.readFile(path.join(STATIC_ROOT, 'index.html'), (err2, html) => {
        if (err2) {
          res.writeHead(404);
          res.end('Not Found（dist-web 未构建？先运行 npm run web:build）');
          return;
        }
        res.writeHead(200, {'content-type': CONTENT_TYPES['.html']});
        res.end(html);
      });
      return;
    }
    res.writeHead(200, {
      'content-type':
        CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    });
    res.end(data);
  });
}

/** /api 反代：Host/Origin 重写为隧道端口（绕过 web_server DNS-rebinding 防护）。 */
function proxyApi(req: http.IncomingMessage, res: http.ServerResponse): void {
  const port = tunnelPort;
  if (port == null) {
    res.writeHead(503, {'content-type': 'application/json; charset=utf-8'});
    res.end(JSON.stringify({error: 'SSH 隧道未建立'}));
    return;
  }
  const headers: Record<string, string | string[] | undefined> = {...req.headers};
  headers.host = `127.0.0.1:${port}`;
  headers.origin = `http://127.0.0.1:${port}`;
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port,
      path: req.url,
      method: req.method,
      headers: headers as Record<string, string>,
    },
    r => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, {'content-type': 'application/json; charset=utf-8'});
    }
    res.end(JSON.stringify({error: '隧道连接失败'}));
  });
  req.pipe(upstream);
}

/** /api/ws WS upgrade：原样转发并重写 Host/Origin（与 HTTP 反代同一策略）。 */
function proxyUpgrade(
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
): void {
  const port = tunnelPort;
  if (port == null) {
    socket.destroy();
    return;
  }
  const upstream = net.connect(port, '127.0.0.1', () => {
    const lines: string[] = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [key, val] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      if (lower === 'host' || lower === 'origin') {
        continue;
      }
      if (Array.isArray(val)) {
        for (const v of val) {
          lines.push(`${key}: ${v}`);
        }
      } else if (val != null) {
        lines.push(`${key}: ${val}`);
      }
    }
    lines.push(`Host: 127.0.0.1:${port}`);
    lines.push(`Origin: http://127.0.0.1:${port}`);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length > 0) {
      upstream.write(head);
    }
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const destroy = () => {
    socket.destroy();
    upstream.destroy();
  };
  socket.on('error', destroy);
  upstream.on('error', destroy);
  socket.on('close', destroy);
  upstream.on('close', destroy);
}

const proxyServer = http.createServer((req, res) => {
  if ((req.url ?? '').startsWith('/api')) {
    proxyApi(req, res);
  } else {
    serveStatic(req, res);
  }
});
proxyServer.on('upgrade', proxyUpgrade);

function listenOn(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', onListening);
  });
}

function readSavedProxyPort(): number | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(app.getPath('userData'), 'proxy-port.json'), 'utf8'),
    ) as {port?: number};
    return typeof parsed.port === 'number' ? parsed.port : null;
  } catch {
    return null;
  }
}

function saveProxyPort(port: number): void {
  try {
    fs.writeFileSync(
      path.join(app.getPath('userData'), 'proxy-port.json'),
      JSON.stringify({port}),
      'utf8',
    );
  } catch {
    // ignore
  }
}

/** 端口跨次启动稳定（localStorage 以 origin 为键）；被占则向后顺延并回写。 */
async function startProxyServer(): Promise<number> {
  const candidates: number[] = [];
  const saved = readSavedProxyPort();
  const BASE = 51899;
  const RANGE = 50;
  if (saved != null && saved >= BASE && saved < BASE + RANGE) {
    candidates.push(saved);
  }
  for (let p = BASE; p < BASE + RANGE; p++) {
    candidates.push(p);
  }
  const tried = new Set<number>();
  for (const port of candidates) {
    if (tried.has(port)) {
      continue;
    }
    tried.add(port);
    try {
      await listenOn(proxyServer, port);
      saveProxyPort(port);
      return port;
    } catch {
      // 端口被占，试下一个
    }
  }
  throw new Error(`回环代理端口 ${BASE}~${BASE + RANGE - 1} 全部被占用`);
}

// ─── IPC 装配 ───────────────────────────────────────────────────

function registerIpc(): void {
  ipcMain.handle('ssh:connect', (_e, cfg: ConnectRequest) => {
    const result = sshConnect({
      ...cfg,
      port: typeof cfg.port === 'number' ? cfg.port : 22,
    });
    // 隧道端口由 openLocalForward 单独登记；disconnect 时清空
    return result;
  });
  ipcMain.handle('ssh:exec', (_e, command: string, timeoutMs: number) =>
    sshExec(command, timeoutMs ?? 20_000),
  );
  ipcMain.handle('ssh:startCommand', (_e, command: string) =>
    sshStartCommand(command),
  );
  ipcMain.handle('ssh:stopCommand', (_e, taskId: string) =>
    sshStopCommand(taskId),
  );
  ipcMain.handle('ssh:openLocalForward', (_e, remotePort: number) =>
    sshOpenLocalForward(remotePort).then(r => {
      tunnelPort = r.localPort;
      return r;
    }),
  );
  ipcMain.handle('ssh:closeLocalForward', (_e, localPort: number) => {
    if (tunnelPort === localPort) {
      tunnelPort = null;
    }
    return sshCloseLocalForward(localPort);
  });
  ipcMain.handle('ssh:disconnect', () => {
    tunnelPort = null;
    return sshDisconnect();
  });
}

// ─── 桌面能力 IPC（文件选择 / 读文件 / 系统通知） ─────────────────

interface PickFilesOptions {
  /** true=图片过滤；false=全部文件 */
  images: boolean;
  multiple: boolean;
}

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic'];

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.py': 'text/plain',
  '.sh': 'text/plain',
  '.yaml': 'text/plain',
  '.yml': 'text/plain',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
};

function registerDesktopIpc(): void {
  // 文件/图片选择（渲染层无原生对话框能力）
  ipcMain.handle(
    'desktop:pickFiles',
    async (_e, opts: PickFilesOptions) => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) {
        return [];
      }
      const properties: Array<
        'openFile' | 'multiSelections'
      > = ['openFile'];
      if (opts.multiple) {
        properties.push('multiSelections');
      }
      const filters = opts.images
        ? [{name: '图片', extensions: IMAGE_EXTENSIONS}]
        : undefined;
      const result = await dialog.showOpenDialog(win, {
        properties,
        filters,
      });
      if (result.canceled || result.filePaths.length === 0) {
        return [];
      }
      return result.filePaths.map(p => ({
        path: p,
        name: path.basename(p),
      }));
    },
  );

  // 读本地文件为 data URL（附件/图片上传链路的桌面读取层）
  ipcMain.handle('desktop:readFileDataUrl', (_e, filePath: string) => {
    const resolved = path.resolve(filePath);
    const mime =
      MIME_BY_EXT[path.extname(resolved).toLowerCase()] ??
      'application/octet-stream';
    return new Promise<string>((resolve, reject) => {
      fs.readFile(resolved, (err, data) => {
        if (err) {
          reject(new Error(`读取文件失败：${err.message}`));
          return;
        }
        resolve(`data:${mime};base64,${data.toString('base64')}`);
      });
    });
  });

  // 系统通知（窗口失焦时回复完成提醒）；点击通知聚焦窗口
  ipcMain.handle(
    'desktop:notify',
    (_e, payload: {title: string; body: string}) => {
      if (!Notification.isSupported()) {
        return false;
      }
      const notification = new Notification({
        title: payload.title,
        body: payload.body,
        silent: false,
      });
      notification.on('click', () => {
        const win = mainWindow;
        if (win) {
          if (win.isMinimized()) {
            win.restore();
          }
          win.show();
          win.focus();
        }
      });
      notification.show();
      return true;
    },
  );
}

// ─── 应用生命周期 ───────────────────────────────────────────────

function createWindow(port: number): void {
  const state = readWindowState();
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: 'HermesChat',
    backgroundColor: '#f2f3f7',
    // 窗口/任务栏图标（开发模式；打包后 exe/bundle 自带同款图标）
    icon: path.join(app.getAppPath(), 'desktop', 'resources', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  win.on('close', () => saveWindowState(win));
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });
  // 安全兜底：禁止 renderer 打开新窗口
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  win.loadURL(`http://127.0.0.1:${port}/`).catch(() => {
    // 窗口关闭等场景的加载中断忽略
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow;
    if (win) {
      if (win.isMinimized()) {
        win.restore();
      }
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    registerIpc();
    registerDesktopIpc();
    // Windows 通知需要 AppUserModelID（打包后由 electron-builder 元数据兜底）
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.hermeschat.desktop');
    }
    // 麦克风（语音输入）权限默认放行；其余保持默认策略
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === 'media');
    });
    const port = await startProxyServer();
    createWindow(port);
  });

  // 单窗口工具：关窗即退出（Windows/Linux/macOS 行为一致，可预期）
  app.on('window-all-closed', () => {
    ssh.intentional = true;
    teardownSsh();
    proxyServer.close();
    app.quit();
  });
}
