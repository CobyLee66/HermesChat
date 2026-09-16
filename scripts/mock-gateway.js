/**
 * mock-gateway.js — 本地 mock Hermes gateway（HTTP + WS JSON-RPC 最小实现）。
 *
 * 用途：让客户端在**不碰真实 gateway 数据**的前提下跑通全链路冒烟——尤其
 * 涉及写操作的验证（AGENTS.md 禁止对 live 9119 写：/title 改名在 mock 里
 * 只改内存）。只实现冒烟所需方法，其余返回 -4040。
 *
 * 已实现：`/`（SPA HTML 带 __HERMES_SESSION_TOKEN__）、`/api/health`、
 * WS `/api/ws` → gateway.ready + profiles.list / session.create / session.list /
 * session.resume（含冷路径换新 live sid）/ session.history / session.usage /
 * complete.slash / slash.exec(title) / session.title / session.delete /
 * session.close / model.options / **prompt.submit（流式回包，只认 live sid，
 * 未知 sid 返 4007）**。
 * live clarify 流（D052）：prompt 文本 `CLARIFY`（单问）/`CLARIFY_BATCH`
 * （批量两题）触发挂起，clarify.respond 全题应答后释放（tool.complete 回显
 * → 续写 → complete，历史落 clarify 工具行）。
 * 测试控制通道：`gw.reapLiveSession(liveSid, reason)` 回收会话并广播
 * session.reclaimed（模拟服务端孤儿回收，供发送自愈冒烟触发）。
 *
 * cron 冒烟 REST：`GET /api/cron/jobs`、`GET /api/cron/jobs/{id}/runs`、
 * `GET /api/sessions/{id}/messages`（dashboard REST 同构；消息行含 tool 行与
 * display_kind=hidden 行，供运行详情「只渲染对话文本」的过滤断言）。
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

/** cron 冒烟种子：一个任务 + 一次运行会话（运行详情被测数据） */
const MOCK_CRON_JOB = {
  id: 'cronjob-smoke-0001',
  name: '每日站会摘要',
  prompt: '整理今天的站会要点并生成摘要',
  enabled: true,
  state: 'scheduled',
  schedule: {kind: 'interval', minutes: 1440},
  repeat: null,
  deliver: 'local',
  next_run_at: '2026-09-11T09:30:00',
  last_run_at: '2026-09-10T09:30:00',
  last_status: null,
  profile: 'mock',
  profile_name: 'mock',
};
const MOCK_CRON_RUN_ID = 'cron-run-smoke-0001';
const MOCK_CRON_RUN = {
  id: MOCK_CRON_RUN_ID,
  title: '每日站会摘要 · 09-10',
  preview: '今日站会要点已生成',
  started_at: Math.floor(Date.now() / 1000) - 600,
  last_active: Math.floor(Date.now() / 1000) - 540,
  message_count: 2,
  is_active: false,
  archived: false,
  profile: 'mock',
  source: 'cron',
};
/** GET /api/sessions/{id}/messages 返回的原始行（含 tool/hidden 行供过滤断言） */
const MOCK_CRON_MESSAGES = {
  session_id: MOCK_CRON_RUN_ID,
  messages: [
    {
      id: 1,
      role: 'user',
      content: '整理今天的站会要点并生成摘要',
      timestamp: MOCK_CRON_RUN.started_at,
    },
    {
      id: 2,
      role: 'tool',
      content: '{"cmd":"cat standup.md"}',
      name: 'bash',
      timestamp: MOCK_CRON_RUN.started_at + 10,
    },
    {
      id: 3,
      role: 'assistant',
      content: '**今日站会要点**\n\n1. 冒烟链路已通\n2. 定时任务视图可用',
      timestamp: MOCK_CRON_RUN.started_at + 20,
    },
    {
      id: 4,
      role: 'user',
      content: '（旧内容，应被隐藏）',
      display_kind: 'hidden',
      timestamp: MOCK_CRON_RUN.started_at + 30,
    },
  ],
  pagination: {limit: 500, offset: 0, order: 'latest', returned: 4},
};

function startMockGateway({
  port = 9199,
  title = MOCK_TITLE,
  /** prompt.submit 流式回包节奏（冒烟断言窗口要留足操作时间）；
   *  rich=true 时在正文流前加推理/工具事件序列（展开卡片冒烟用，见
   *  web-expand-cards-smoke.js）：reasoning.delta（首行入 head 预览、
   *  中部标记 RICH_REASONING_MID 仅展开全文可见、长尾入 tail 预览）→
   *  tool.start/progress/complete（result 尾部标记 RICH_TOOL_RESULT_END） */
  stream = {},
  /** 额外种子 N 条历史消息（交替 user/assistant），测长历史懒挂载场景 */
  historyCount = 0,
  /**
   * 会话挂起的 clarify 快照（真实服务端 `_live_session_payload` 的
   * `pending_clarify` 是**单个对象**，不是数组）：`session.resume` 带上它，
   * 客户端须恢复澄清卡而不是抛 TypeError。可运行期改 `gw.state.pendingClarify`
   * 切换场景（null = 无挂起交互）。
   */
  pendingClarify = null,
} = {}) {
  const {chunks = 24, intervalMs = 400, rich = false} = stream;
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
    /** 挂起的 clarify 快照（单对象；clarify.respond 后清空，模拟服务端解锁） */
    pendingClarify,
    /**
     * live clarify 流（prompt 文本 CLARIFY / CLARIFY_BATCH 触发）：非空表示
     * turn 挂起在 clarify 上（message.start 已发、complete 未发——保真真实
     * 服务端挂起期间不发 message.complete），全题应答后由 clarify.respond
     * 释放：tool.complete(答案回显) → 续写 delta → message.complete →
     * 历史落 clarify 工具行（供重进会话「历史只读卡」冒烟）。
     */
    liveClarify: null,
    /** 当前思考等级（config.get/set reasoning 的内存态；默认 medium = 服务端回落值） */
    reasoningEffort: 'medium',
    // ── 会话生命周期（2026-09-16 发送自愈冒烟用，其余冒烟不触碰）──
    /** seed 会话当前 live sid（被 reap 后冷路径 resume 会换新值） */
    seededLiveSid: LIVE_ID,
    /** seed 会话是否已被 reap（下次 resume 走冷路径换新 live sid） */
    seededReaped: false,
    /** seed 会话冷路径计数（live0002、live0003…） */
    seededCounter: 1,
    /** session.create 出来的新会话（首条 prompt 前不落库 = 不进 session.list） */
    extraSessions: [],
    extraCounter: 0,
    /** 活跃 WS 的 send 函数（reapLiveSession 广播用） */
    senders: new Set(),
  };

  const ok = (id, value) => JSON.stringify({jsonrpc: '2.0', id, result: value});
  const err = (id, code, message) =>
    JSON.stringify({jsonrpc: '2.0', id, error: {code, message}});

  /** 定时器统一登记（close 时清理） */
  const later = (fn, ms) => {
    const t = setTimeout(() => {
      state.timers.delete(t);
      fn();
    }, ms);
    state.timers.add(t);
  };

  /** 按帧级 session_id 单播事件（mock 单连接等价真实单播） */
  const emitTo = (send, liveSid, type, payload) =>
    send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: {type, session_id: liveSid, payload},
      }),
    );

  /**
   * live clarify 释放（全部问题应答后由 clarify.respond 触发）：照真实服务端
   * 事件序——tool.complete（答案回显：单问=纯文本，批量=JSON {answers}）→
   * 续写 message.delta → message.complete，并把 assistant 前文行 / clarify
   * 工具行（投影只带 args 不带 result）/ assistant 续写行落进历史投影。
   */
  function releaseLiveClarify(send) {
    const lc = state.liveClarify;
    if (!lc) {
      return;
    }
    state.liveClarify = null;
    state.pendingClarify = null;
    const isBatch = Array.isArray(lc.payload.questions);
    emitTo(send, lc.liveSid, 'tool.complete', {
      tool_id: lc.toolId,
      name: 'clarify',
      result_text: isBatch
        ? JSON.stringify({answers: lc.payload.answers ?? {}})
        : String(lc.answer ?? ''),
      duration_s: 1.2,
    });
    const parts = [
      '收到你的回答，我按这个口径继续。CLARIFY_CONTINUATION_MARK 第一段：澄清结束后输出应显示在澄清卡下方。\n\n',
      'CLARIFY_CONTINUATION_MARK 第二段：卡片应停留在它被回答时的历史位置，不再钉在会话底部。\n\n',
      'CLARIFY_CONTINUATION_MARK 第三段（收尾）。\n\n',
    ];
    parts.forEach((text, i) =>
      later(
        () => emitTo(send, lc.liveSid, 'message.delta', {text}),
        300 + i * 350,
      ),
    );
    later(() => {
      const fullText = parts.join('');
      emitTo(send, lc.liveSid, 'message.complete', {
        text: fullText,
        usage: {
          model: 'mock-model',
          context_used: 120,
          context_max: 8000,
          context_percent: 2,
        },
      });
      const now = Math.floor(Date.now() / 1000);
      lc.messages.push({role: 'assistant', text: lc.preText, timestamp: now});
      lc.messages.push({
        role: 'tool',
        name: 'clarify',
        args: isBatch
          ? {
              questions: lc.payload.questions.map(q => ({
                question: q.question,
                choices: q.choices,
                ...(q.multi_select ? {multi_select: true} : null),
              })),
            }
          : {question: lc.payload.question, choices: lc.payload.choices},
        timestamp: now,
      });
      lc.messages.push({role: 'assistant', text: fullText, timestamp: now});
    }, 300 + parts.length * 350 + 150);
  }

  const mockInfo = sessionTitle => ({
    model: 'mock-model',
    provider: 'mock',
    title: sessionTitle,
    reasoning_effort: state.reasoningEffort,
    running: false,
    profile_name: PROFILE,
  });

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
              // 新建会话**落库后**才可见（服务端首次 prompt.submit 才写
              // sessions 行）——空会话被回收后列表里永远不出现
              ...state.extraSessions
                .filter(s => s.persisted)
                .map(s => ({
                  id: s.storedId,
                  title: s.title || '未命名会话',
                  preview:
                    String(s.messages[s.messages.length - 1]?.text ?? '').slice(0, 60),
                  started_at: Math.floor(Date.now() / 1000) - 30,
                  message_count: s.messages.length,
                  source: 'tui',
                })),
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
      case 'session.create': {
        // 真实网关语义：live sid + 持久化 id 都由服务端分配；空会话此时
        // **未落库**（不进 session.list、被回收后 resume 必 4007）
        state.extraCounter += 1;
        const n = state.extraCounter;
        const created = {
          storedId: `storedN${String(n).padStart(3, '0')}`,
          liveSid: `liveN${String(n).padStart(3, '0')}`,
          title: String(params.title ?? '').trim(),
          messages: [],
          live: true,
          persisted: false,
        };
        state.extraSessions.push(created);
        send(
          ok(id, {
            session_id: created.liveSid,
            stored_session_id: created.storedId,
            message_count: 0,
            messages: [],
            info: mockInfo(created.title),
          }),
        );
        return;
      }
      case 'session.resume': {
        const requested = String(params.session_id ?? '');
        if (requested === STORED_ID) {
          let liveSid = state.seededLiveSid;
          if (state.seededReaped) {
            // 冷路径：被回收的持久化会话重建 agent，返回**新** live sid
            //（客户端据此迁移 bySession key，发送自愈被测行为）
            state.seededCounter += 1;
            liveSid = `live${String(state.seededCounter).padStart(4, '0')}`;
            state.seededLiveSid = liveSid;
            state.seededReaped = false;
          }
          state.liveActive = true;
          send(
            ok(id, {
              session_id: liveSid,
              stored_session_id: STORED_ID,
              running: false,
              messages: state.messages,
              info: mockInfo(state.title),
              // 真实服务端形态：**单个对象**（不是数组）；无挂起时不带该字段
              ...(state.pendingClarify
                ? {pending_clarify: state.pendingClarify}
                : null),
            }),
          );
          return;
        }
        const extra = state.extraSessions.find(s => s.storedId === requested);
        if (!extra) {
          // 库中无行（空会话未落库即被回收 / 他端已删）→ 4007
          send(err(id, 4007, 'session not found'));
          return;
        }
        if (!extra.live) {
          extra.live = true;
          extra.extraSeq = (extra.extraSeq ?? 0) + 1;
          extra.liveSid = `liveN${String(state.extraCounter).padStart(3, '0')}R${extra.extraSeq}`;
        }
        send(
          ok(id, {
            session_id: extra.liveSid,
            stored_session_id: extra.storedId,
            running: false,
            messages: extra.messages,
            info: mockInfo(extra.title),
          }),
        );
        return;
      }
      case 'clarify.respond': {
        // 真实网关语义：clarify.respond 查全局 pending 注册表（不需要
        // session_id）；有 question_id 即批量逐题锁答案，否则整题解锁。
        const rid = String(params.request_id ?? '');
        const qid = String(params.question_id ?? '');
        const pending = state.pendingClarify;
        if (!pending || pending.request_id !== rid) {
          send(err(id, 4009, `no pending clarify request`));
          return;
        }
        if (qid && Array.isArray(pending.questions)) {
          // 逐题锁答案（update-in-place）；qid 全锁定即整批完成、注册表清空
          pending.answers = pending.answers || {};
          pending.answers[qid] = String(params.answer ?? '');
          const remaining = pending.questions
            .map(q => q.qid)
            .filter(q => !(q in pending.answers));
          if (remaining.length === 0) {
            state.pendingClarify = null;
            if (state.liveClarify && state.liveClarify.payload === pending) {
              releaseLiveClarify(send);
            }
          }
          send(ok(id, {status: 'ok', remaining}));
          return;
        }
        state.pendingClarify = null;
        if (state.liveClarify && state.liveClarify.payload === pending) {
          state.liveClarify.answer = String(params.answer ?? '');
          releaseLiveClarify(send);
        }
        send(ok(id, {status: 'ok'}));
        return;
      }
      case 'session.history':
        send(ok(id, {count: state.messages.length, messages: state.messages}));
        return;
      case 'session.usage': {
        // 真实网关语义：_sess_nowait 直查内存表，只认 live sid（持久化 id
        // 一律 4001）；顶层返回 usage dict（agent 未建时零计数 dict）
        const sid = String(params.session_id ?? '');
        const known =
          (sid === state.seededLiveSid && state.liveActive) ||
          state.extraSessions.some(s => s.live && s.liveSid === sid);
        if (!known) {
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
        // 裸 /reasoning 查询（等级设置已被客户端拦截走 config.set，到不了这里）
        if (/^reasoning$/.test(cmd)) {
          send(
            ok(id, {output: `  Reasoning effort: ${state.reasoningEffort}`}),
          );
          return;
        }
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
        if (target === state.seededLiveSid) {
          send(err(id, 4007, 'session not found'));
          return;
        }
        if (target !== STORED_ID) {
          const extra = state.extraSessions.find(s => s.storedId === target);
          if (!extra) {
            send(err(id, 4007, 'session not found'));
            return;
          }
          if (extra.live) {
            send(err(id, 4023, 'cannot delete an active session'));
            return;
          }
          state.extraSessions = state.extraSessions.filter(s => s !== extra);
          send(ok(id, {deleted: target}));
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
        const extra = state.extraSessions.find(
          s => s.live && s.liveSid === sid,
        );
        if (extra) {
          extra.live = false;
          send(ok(id, {closed: true}));
          return;
        }
        if (sid === state.seededLiveSid && state.liveActive) {
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
      case 'config.get':
        if (params.key === 'reasoning') {
          send(ok(id, {value: state.reasoningEffort, display: 'show'}));
          return;
        }
        send(err(id, 4002, `mock: 未实现的 config.get key ${params.key}`));
        return;
      case 'config.set': {
        if (params.key !== 'reasoning') {
          send(err(id, 4002, `mock: 未实现的 config.set key ${params.key}`));
          return;
        }
        // 真实服务端语义：非法等级 err 4002；成功后应用 live 会话并推
        // session.info 事件（顶栏经事件路径刷新思考等级）
        const level = String(params.value ?? '').trim().toLowerCase();
        const LEVELS = [
          'none',
          'minimal',
          'low',
          'medium',
          'high',
          'xhigh',
          'max',
          'ultra',
        ];
        if (!LEVELS.includes(level)) {
          send(err(id, 4002, `unknown reasoning value: ${params.value}`));
          return;
        }
        state.reasoningEffort = level;
        send(ok(id, {key: 'reasoning', value: level}));
        send(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'event',
            params: {
              type: 'session.info',
              session_id: LIVE_ID,
              payload: {
                model: 'mock-model',
                provider: 'mock',
                title: state.title,
                reasoning_effort: level,
                running: false,
                profile_name: PROFILE,
                // 真实 _session_info 带 usage（session.info/usage 事件同构），
                // 缺了它顶栏的用量段会在 info 整体替换后消失
                usage: {...MOCK_USAGE},
              },
            },
          }),
        );
        return;
      }
      case 'prompt.submit': {
        const text = String(params.text ?? '');
        // 真实网关语义：prompt.submit 只认 live sid，查无 → 4007 session
        // not found（发送自愈被测行为）；同时首条 prompt 触发落库
        //（_ensure_session_db_row），空会话从此进 session.list。
        let target;
        if (
          String(params.session_id ?? '') === state.seededLiveSid &&
          state.liveActive
        ) {
          target = {messages: state.messages, liveSid: state.seededLiveSid};
        } else {
          const extra = state.extraSessions.find(
            s => s.live && s.liveSid === String(params.session_id ?? ''),
          );
          if (extra) {
            extra.persisted = true;
            target = {messages: extra.messages, liveSid: extra.liveSid};
          }
        }
        if (!target) {
          send(err(id, 4007, 'session not found'));
          return;
        }
        target.messages.push({
          role: 'user',
          text,
          timestamp: Math.floor(Date.now() / 1000),
        });
        send(ok(id, {status: 'streaming'}));
        // 事件帧单播（真实服务端只发绑定的 transport，mock 单连接等价）
        const liveSid = target.liveSid;
        const emit = (type, payload) =>
          send(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'event',
              params: {type, session_id: liveSid, payload},
            }),
          );
        const timer = (fn, ms) => later(fn, ms);
        // ── live clarify 流（CLARIFY / CLARIFY_BATCH 触发，D052 冒烟用）──
        // 照真实事件序：message.start → 前文 delta → tool.start(clarify) →
        // clarify.request，然后**挂起**（不发 message.complete——服务端阻塞
        // 在工具回调里），等 clarify.respond 全题应答后由 releaseLiveClarify
        // 释放（tool.complete 回显 → 续写 → complete → 历史落工具行）。
        const clarifyMatch = text.match(/^CLARIFY(_BATCH)?/i);
        if (clarifyMatch) {
          const batch = Boolean(clarifyMatch[1]);
          const payload = batch
            ? {
                request_id: `cl-live-${Date.now()}`,
                questions: [
                  {
                    qid: 'q0',
                    question: '使用哪个数据集？',
                    choices: ['A数据集', 'B数据集'],
                  },
                  {qid: 'q1', question: '时间范围是？', choices: []},
                ],
              }
            : {
                request_id: `cl-live-${Date.now()}`,
                question: '要下载 PDF 还是 HTML 版本？',
                choices: ['PDF', 'HTML'],
              };
          const preText = '好的，在动手前先确认：';
          state.pendingClarify = payload;
          state.liveClarify = {
            payload,
            liveSid,
            messages: target.messages,
            toolId: 'mock-clarify-tool',
            preText,
          };
          emit('message.start', {});
          timer(() => emit('message.delta', {text: preText}), 120);
          timer(
            () =>
              emit('tool.start', {
                tool_id: 'mock-clarify-tool',
                name: 'clarify',
              }),
            400,
          );
          timer(() => emit('clarify.request', payload), 550);
          return;
        }
        emit('message.start', {});
        // 首个事件 120ms 即到（客户端尽快看到内容）；rich 前序事件推后正文起点
        let at = 120;
        if (rich) {
          timer(
            () =>
              emit('reasoning.delta', {
                text: '推理首行内容（折叠态预览只显示这一行）。\n',
              }),
            at,
          );
          timer(
            () =>
              emit('reasoning.delta', {
                text:
                  `${'甲'.repeat(150)}\n中部 RICH_REASONING_MID 仅此一处。\n` +
                  `${'乙'.repeat(150)}\n`,
              }),
            (at += 250),
          );
          for (let i = 0; i < 4; i++) {
            const line = `推理尾段第 ${i + 1} 行。${'丙'.repeat(50)}\n`;
            timer(() => emit('reasoning.delta', {text: line}), (at += 250));
          }
          timer(
            () =>
              emit('tool.start', {
                tool_id: 'mock-rich-tool',
                name: 'read_file',
                context: '/tmp/rich.txt',
                args: {path: '/tmp/rich.txt'},
              }),
            (at += 250),
          );
          timer(
            () =>
              emit('tool.progress', {
                tool_id: 'mock-rich-tool',
                preview: '读取中…',
              }),
            (at += 200),
          );
          timer(
            () =>
              emit('tool.complete', {
                tool_id: 'mock-rich-tool',
                name: 'read_file',
                args: {path: '/tmp/rich.txt'},
                result_text: '文件内容若干行\nRICH_TOOL_RESULT_END',
                duration_s: 0.4,
              }),
            (at += 300),
          );
        }
        const parts = [];
        for (let i = 0; i < chunks; i++) {
          const n = i + 1;
          parts.push(
            `【第 ${n}/${chunks} 段】流式滚动跟随冒烟测试文本：这一段刻意写得更长，` +
              `让气泡高度尽早超过视口，供上滑暂停与锚定补偿断言使用。\n\n`,
          );
          const text = parts[i];
          // 首段即到，之后按 intervalMs 节奏吐出
          timer(() => emit('message.delta', {text}), at + i * intervalMs);
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
          target.messages.push({
            role: 'assistant',
            text: fullText,
            timestamp: Math.floor(Date.now() / 1000),
          });
        }, at + chunks * intervalMs + 150);
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
    // ─── dashboard REST（cron 冒烟）──────────────────────────────
    if (path === '/api/cron/jobs') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify([MOCK_CRON_JOB]));
      return;
    }
    const runsMatch = path.match(/^\/api\/cron\/jobs\/([^/]+)\/runs$/);
    if (runsMatch) {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({runs: [MOCK_CRON_RUN], limit: 20}));
      return;
    }
    const msgsMatch = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (msgsMatch) {
      if (decodeURIComponent(msgsMatch[1]) !== MOCK_CRON_RUN_ID) {
        res.writeHead(404, {'content-type': 'application/json'});
        res.end(JSON.stringify({detail: 'Session not found'}));
        return;
      }
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify(MOCK_CRON_MESSAGES));
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
      state.senders.add(send);
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
        state.senders.delete(send);
        state.wsClosed = {
          code,
          reason: String(reason || ''),
          at: Date.now(),
        };
      });
    });
  });

  /**
   * 测试控制通道：回收一个 live 会话（模拟服务端 ws_orphan_reap /
   * idle_timeout）。默认广播 session.reclaimed（帧级无 session_id 的**全局**
   * 广播，客户端置 staleLive 走发送快路径自愈）；broadcast=false 模拟网关
   * 进程直接死亡（无任何通知，客户端发送撞 4007 走 catch 自愈路径）。
   * 空会话（persisted=false）回收后从注册表移除——resume 必 4007、
   * session.list 永远不可见，与真实服务端「首次 prompt 前不落库」一致。
   */
  function reapLiveSession(liveSid, reason = 'ws_orphan_reap', {broadcast = true} = {}) {
    let storedId = STORED_ID;
    if (liveSid === state.seededLiveSid) {
      state.liveActive = false;
      state.seededReaped = true;
    } else {
      const extra = state.extraSessions.find(
        s => s.live && s.liveSid === liveSid,
      );
      if (!extra) {
        return false;
      }
      storedId = extra.storedId;
      extra.live = false;
      if (!extra.persisted) {
        state.extraSessions = state.extraSessions.filter(s => s !== extra);
      }
    }
    if (!broadcast) {
      return true;
    }
    const frame = JSON.stringify({
      jsonrpc: '2.0',
      method: 'event',
      params: {
        type: 'session.reclaimed',
        session_id: '',
        payload: {
          session_id: liveSid,
          stored_session_id: storedId,
          reason,
        },
      },
    });
    for (const send of state.senders) {
      send(frame);
    }
    return true;
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        state,
        reapLiveSession,
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
  MOCK_CRON_JOB,
  MOCK_CRON_RUN,
  MOCK_CRON_RUN_ID,
  MOCK_CRON_MESSAGES,
};
