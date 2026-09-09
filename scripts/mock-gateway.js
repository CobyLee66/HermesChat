/**
 * mock-gateway.js — 本地 mock Hermes gateway（HTTP + WS JSON-RPC 最小实现）。
 *
 * 用途：让客户端在**不碰真实 gateway 数据**的前提下跑通全链路冒烟——尤其
 * 涉及写操作的验证（AGENTS.md 禁止对 live 9119 写：/title 改名在 mock 里
 * 只改内存）。只实现冒烟所需方法，其余返回 -4040。
 *
 * 已实现：`/`（SPA HTML 带 __HERMES_SESSION_TOKEN__）、`/api/health`、
 * WS `/api/ws` → gateway.ready + profiles.list / session.list / session.resume /
 * session.history / session.usage / complete.slash / slash.exec(title) /
 * session.title / session.delete / session.close / model.options /
 * **prompt.submit（流式回包）**。
 *
 * 关键保真点（照真实服务端行为，docs/protocol.md §2）：
 * - `slash.exec` 执行 `/title X` **只改标题、不推任何事件**；
 * - `session.title` 不带 title 参数 = 只读形式，返回 `{title, session_key}`。
 * 客户端必须靠「命令后主动读回」才能立即刷新（这正是被测行为）。
 * - `prompt.submit` → `{status:"streaming"}`，随后事件帧单播：message.start →
 *   message.delta{text}×N（定时）→ message.complete{text}，帧 params 带
 *   session_id（live sid，wireEvents 按它路由到会话）。
 *
 * 用法（库）：const {startMockGateway} = require('./mock-gateway');
 *           const gw = await startMockGateway({port: 9199});
 *           gw.state.title / gw.state.calls（调用流水）/ await gw.close();
 * 用法（CLI）：node scripts/mock-gateway.js [port]
 */

const http = require('node:http');
// node_modules 根部的 ws 是 v6（vite 等传递依赖），导出形态是 WebSocket.Server
// 而非 v8 的具名 WebSocketServer——两者都有 noServer/handleUpgrade，够用
const WebSocket = require('ws');
const WebSocketServer = WebSocket.Server;

const TOKEN = 'mock-session-token';
const STORED_ID = 'stored-mock-0001';
const LIVE_ID = 'live0001';
const PROFILE = 'mock';
const MOCK_TITLE = '原标题';
/** 进程内 usage 快照：session.usage RPC 返回**顶层 dict**（methods_session.py
 * `_get_usage` 同源口径，只认 live sid）。注意与 resume 返回的 info 无关——
 * 真实服务端 info 普遍缺 usage，客户端必须主动调 session.usage 才能拿到
 * 上下文用量（这正是「重进会话主动同步」被测的行为）。 */
const MOCK_USAGE = {
  model: 'mock-model',
  input: 2100,
  output: 1350,
  total: 3450,
  calls: 2,
  context_used: 3450,
  context_max: 8000,
  context_percent: 43,
};
const INITIAL_HISTORY = [
  {role: 'user', text: '你好，这是 mock 会话', timestamp: 1700000000},
  {role: 'assistant', text: '收到，我是 mock gateway 的假回复。', timestamp: 1700000001},
];

function startMockGateway({
  port = 9199,
  title = MOCK_TITLE,
  /** prompt.submit 流式回包节奏（冒烟断言窗口要留足操作时间） */
  stream = {},
  /** 额外种子 N 条历史消息（交替 user/assistant），测长历史懒挂载场景 */
  historyCount = 0,
} = {}) {
  const {chunks = 24, intervalMs = 400} = stream;
  const seedHistory = [];
  for (let i = 1; i <= historyCount; i++) {
    seedHistory.push({
      role: i % 2 === 1 ? 'user' : 'assistant',
      text: `【历史 ${i}/${historyCount}】mock 种子历史消息，用于测试进会话后` +
        '首次向上滚动时旧消息 cell 的懒挂载路径。',
      timestamp: 1700000000 + i,
    });
  }
  const state = {
    title,
    /** RPC 调用流水 [{method, params}]——断言调用顺序用 */
    calls: [],
    /** 当前 WS 连接数 */
    sockets: 0,
    /** 会话是否 live（session.resume 挂载 / session.close 摘除），delete 4023 判定用 */
    liveActive: false,
    /** 运行期消息投影（prompt 往里追加，resume/history 用） */
    messages: [...INITIAL_HISTORY, ...seedHistory],
    /** 进行中的流式定时器（close 时清理） */
    timers: new Set(),
    /** 诊断：delta 发送计数 / WS 关闭信息 / 最近一次 send 异常 */
    deltaSent: 0,
    wsClosed: null,
    lastSendError: null,
  };

  const ok = (id, value) => JSON.stringify({jsonrpc: '2.0', id, result: value});
  const err = (id, code, message) =>
    JSON.stringify({jsonrpc: '2.0', id, error: {code, message}});

  function dispatch(send, req) {
    const {id, method, params = {}} = req;
    state.calls.push({method, params});
    switch (method) {
      case 'profiles.list':
        send(
          ok(id, {
            profiles: [
              {
                name: PROFILE,
                path: '/tmp/mock-profile',
                is_default: true,
                model: 'mock-model',
                provider: 'mock',
                description: 'mock profile',
                skill_count: 0,
                last_session: null,
              },
            ],
          }),
        );
        return;
      case 'session.list':
        send(
          ok(id, {
            sessions: [
              {
                id: STORED_ID,
                title: state.title,
                preview: 'mock 会话',
                started_at: Math.floor(Date.now() / 1000) - 60,
                message_count: state.messages.length,
                source: 'tui',
              },
            ],
          }),
        );
        return;
      case 'session.resume':
        state.liveActive = true;
        send(
          ok(id, {
            session_id: LIVE_ID,
            stored_session_id: STORED_ID,
            running: false,
            messages: state.messages,
            info: {
              model: 'mock-model',
              provider: 'mock',
              title: state.title,
              running: false,
              profile_name: PROFILE,
            },
          }),
        );
        return;
      case 'session.history':
        send(ok(id, {count: state.messages.length, messages: state.messages}));
        return;
      case 'session.usage': {
        // 真实网关语义：_sess_nowait 直查内存表，只认 live sid（持久化 id
        // 一律 4001）；顶层返回 usage dict（agent 未建时零计数 dict）
        if (String(params.session_id ?? '') !== LIVE_ID) {
          send(err(id, 4001, 'session not found'));
          return;
        }
        send(ok(id, {...MOCK_USAGE}));
        return;
      }
      case 'complete.slash':
        // 不提供补全项：避免浮层遮挡（被测行为与补全无关）
        send(ok(id, {items: [], replace_from: 1}));
        return;
      case 'slash.exec': {
        const cmd = String(params.command ?? '').trim();
        const m = cmd.match(/^title(?:\s+([\s\S]*))?$/);
        if (!m) {
          send(err(id, 4018, `mock: 未实现的斜杠命令 /${cmd}`));
          return;
        }
        const arg = (m[1] ?? '').trim();
        if (!arg) {
          send(ok(id, {output: `  Title: ${state.title}`}));
          return;
        }
        // 真实服务端：slash worker 直接写库、不推事件（这就是「标题不刷新」的根因）
        state.title = arg;
        send(ok(id, {output: `  Session title set: ${arg}`}));
        return;
      }
      case 'session.title':
        if (typeof params.title === 'string' && params.title.trim()) {
          state.title = params.title.trim();
          send(ok(id, {pending: false, title: state.title}));
        } else {
          // 只读形式：客户端 /title 命令后靠它读回权威标题
          send(ok(id, {title: state.title, session_key: STORED_ID}));
        }
        return;
      case 'session.delete': {
        // 真实网关语义：活动判定与查库都按持久化 id——live sid 一律 4007；
        // 活动会话 4023（客户端应先 session.close(live sid) 再重试）
        const target = String(params.session_id ?? '');
        if (target === LIVE_ID || target !== STORED_ID) {
          send(err(id, 4007, 'session not found'));
          return;
        }
        if (state.liveActive) {
          send(err(id, 4023, 'cannot delete an active session'));
          return;
        }
        send(ok(id, {deleted: target}));
        return;
      }
      case 'session.close': {
        // 真实网关语义：close 直查内存表，只认 live sid；持久化 id 返回
        // closed:false（不报错）
        const sid = String(params.session_id ?? '');
        if (sid === LIVE_ID && state.liveActive) {
          state.liveActive = false;
          send(ok(id, {closed: true}));
          return;
        }
        send(ok(id, {closed: false}));
        return;
      }
      case 'model.options':
        send(ok(id, {providers: [], model: 'mock-model', provider: 'mock'}));
        return;
      case 'prompt.submit': {
        const text = String(params.text ?? '');
        state.messages.push({
          role: 'user',
          text,
          timestamp: Math.floor(Date.now() / 1000),
        });
        send(ok(id, {status: 'streaming'}));
        // 事件帧单播（真实服务端只发绑定的 transport，mock 单连接等价）
        const emit = (type, payload) =>
          send(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'event',
              params: {type, session_id: LIVE_ID, payload},
            }),
          );
        const timer = (fn, ms) => {
          const t = setTimeout(() => {
            state.timers.delete(t);
            fn();
          }, ms);
          state.timers.add(t);
        };
        emit('message.start', {});
        const parts = [];
        for (let i = 0; i < chunks; i++) {
          const n = i + 1;
          parts.push(
            `【第 ${n}/${chunks} 段】流式滚动跟随冒烟测试文本：这一段刻意写得更长，` +
              `让气泡高度尽早超过视口，供上滑暂停与锚定补偿断言使用。\n\n`,
          );
          // 首段 120ms 即到（客户端尽快看到内容），之后按 intervalMs 节奏吐出
          const text = parts[i];
          timer(() => emit('message.delta', {text}), 120 + i * intervalMs);
        }
        timer(() => {
          const fullText = parts.join('');
          emit('message.complete', {
            text: fullText,
            usage: {
              model: 'mock-model',
              context_used: 100,
              context_max: 8000,
              context_percent: 2,
            },
          });
          state.messages.push({
            role: 'assistant',
            text: fullText,
            timestamp: Math.floor(Date.now() / 1000),
          });
        }, 120 + chunks * intervalMs + 150);
        return;
      }
      default:
        send(err(id, 4040, `mock: unhandled method ${method}`));
    }
  }

  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/') {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      res.end(
        `<!doctype html><html><head><title>mock gateway</title></head><body>` +
          `<script>window.__HERMES_SESSION_TOKEN__="${TOKEN}";</script>` +
          `mock gateway</body></html>`,
      );
      return;
    }
    if (path === '/api/health') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: true, version: 'mock-gateway'}));
      return;
    }
    if (path === '/api/status') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: true}));
      return;
    }
    res.writeHead(404, {'content-type': 'application/json'});
    res.end(JSON.stringify({detail: `mock: not found ${path}`}));
  });

  const wss = new WebSocketServer({noServer: true});
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => {
      state.sockets += 1;
      const send = raw => {
        // readyState 1 = OPEN（ws v6/v8 常量位置不同，直接比较数值最稳）
        if (ws.readyState === 1) {
          try {
            ws.send(raw);
            if (raw.includes('"message.delta"')) {
              state.deltaSent += 1;
            }
          } catch (e) {
            state.lastSendError = String(e);
          }
        }
      };
      send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'event',
          params: {type: 'gateway.ready', payload: {skin: {}, change_events: true}},
        }),
      );
      ws.on('message', raw => {
        let req;
        try {
          req = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (req && typeof req.id === 'number' && typeof req.method === 'string') {
          dispatch(send, req);
        }
      });
      ws.on('close', (code, reason) => {
        state.sockets -= 1;
        state.wsClosed = {
          code,
          reason: String(reason || ''),
          at: Date.now(),
        };
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        state,
        close: () =>
          new Promise(r => {
            state.timers.forEach(t => clearTimeout(t));
            state.timers.clear();
            wss.close();
            server.close(() => r());
          }),
      });
    });
  });
}

if (require.main === module) {
  const port = Number(process.argv[2] || 9199);
  startMockGateway({port}).then(gw =>
    console.log(`mock gateway: http://127.0.0.1:${gw.port}（Ctrl+C 退出）`),
  );
}

module.exports = {
  startMockGateway,
  TOKEN,
  STORED_ID,
  LIVE_ID,
  PROFILE,
  MOCK_TITLE,
  MOCK_USAGE,
};
