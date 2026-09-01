#!/usr/bin/env node
/**
 * HermesMobile 端到端 harness（纯 Node 22，全局 fetch/WebSocket）。
 *
 * 流程：
 *   1. GET / 提取 __HERMES_SESSION_TOKEN__
 *   2. 连 WS /api/ws?token=...，等 gateway.ready
 *   3. profiles.list（打印原始结构）
 *   4. session.list {profile:"main"}
 *   5. session.create {profile:"main", cols:100, title:"HermesMobile-harness"}
 *   6. prompt.submit 一次（"回复 pong 两个字即可"）→ 收集事件直到 message.complete
 *   7. session.close 清理
 *   8. 结构 probe：model.options、profiles.get_asset（profile "main"）
 *
 * 纪律：全流程仅一次真实 prompt.submit；不做任何 config.set / 删除用户会话。
 * slash.exec 的 /reset 结构仅从源码确认（见 docs/protocol.md），不在此发送。
 */

const BASE = process.env.HERMES_BASE || 'http://127.0.0.1:9119';
const PROFILE = 'main';
const PROMPT = '回复 pong 两个字即可';

const t0 = Date.now();
function ts() {
  return `+${((Date.now() - t0) / 1000).toFixed(2)}s`;
}
function log(...args) {
  console.log(`[${ts()}]`, ...args);
}
function fail(msg) {
  console.error(`[${ts()}] FAIL: ${msg}`);
  process.exitCode = 1;
}

// ─── 最小 JSON-RPC over WS 客户端 ──────────────────────────────

class MiniRpc {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = [];
    this.timeline = [];
  }

  connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('gateway.ready timeout')), 15000);
      ws.onerror = () => reject(new Error('ws error'));
      ws.onclose = e => {
        if (!this.ready) {
          reject(new Error(`ws closed before ready: code=${e.code}`));
        }
        this.onClose && this.onClose(e);
      };
      ws.onmessage = ev => {
        let frame;
        try {
          frame = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (frame.method === 'event') {
          const {type, session_id, payload} = frame.params ?? {};
          this.timeline.push({t: ts(), type, session_id, payload});
          if (type === 'gateway.ready') {
            this.ready = true;
            clearTimeout(timer);
            resolve();
          }
          for (const h of this.eventHandlers) h(frame.params);
          return;
        }
        if (typeof frame.id === 'number') {
          const p = this.pending.get(frame.id);
          if (p) {
            this.pending.delete(frame.id);
            if (frame.error) {
              const err = new Error(frame.error.message);
              err.code = frame.error.code;
              p.reject(err);
            } else {
              p.resolve(frame.result);
            }
          }
        }
      };
    });
  }

  call(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.ws.send(JSON.stringify({jsonrpc: '2.0', id, method, params}));
      setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`timeout: ${method}`));
        }
      }, 60000);
    });
  }

  onEvent(h) {
    this.eventHandlers.push(h);
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }
}

function summarizePayload(payload) {
  if (payload === undefined || payload === null) {
    return '';
  }
  const s = JSON.stringify(payload);
  if (!s) {
    return '';
  }
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
}

// ─── 主流程 ────────────────────────────────────────────────────

async function main() {
  // 1. token
  log(`GET ${BASE}/ ...`);
  const resp = await fetch(`${BASE}/`);
  const html = await resp.text();
  const m = html.match(/__HERMES_SESSION_TOKEN__="([^"]+)"/);
  if (!m) {
    throw new Error('SPA HTML 中未找到 __HERMES_SESSION_TOKEN__');
  }
  const token = m[1];
  log(`token=${token.slice(0, 6)}…(${token.length} chars)`);

  // 2. WS
  const wsUrl = `${BASE.replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(token)}`;
  const rpc = new MiniRpc();
  log(`WS ${wsUrl.replace(token, '***')} ...`);
  await rpc.connect(wsUrl);
  log('gateway.ready ✓');

  try {
    // 3. profiles.list（打印原始结构一次）
    const profilesRaw = await rpc.call('profiles.list');
    log('profiles.list 原始返回结构：');
    console.log(
      JSON.stringify(
        profilesRaw,
        (k, v) => (k === 'path' ? '<path>' : v),
        2,
      ).slice(0, 3000),
    );

    // 4. session.list
    const listResult = await rpc.call('session.list', {profile: PROFILE, limit: 20});
    const sessions = listResult?.sessions ?? [];
    log(`session.list {profile:"${PROFILE}"} → ${sessions.length} 个会话`);
    if (sessions[0]) {
      log('首条字段:', Object.keys(sessions[0]).join(', '));
    }

    // 5. session.create
    const created = await rpc.call('session.create', {
      profile: PROFILE,
      cols: 100,
      title: 'HermesMobile-harness',
    });
    const sid = created.session_id;
    log(`session.create → session_id=${sid} stored=${created.stored_session_id} info.model=${created.info?.model} profile=${created.info?.profile_name}`);

    // 6. prompt.submit + 收集事件
    const turnDone = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('等待 message.complete 超时 (120s)')), 120000);
      rpc.onEvent(evt => {
        if (evt.session_id !== sid) {
          return;
        }
        if (evt.type === 'message.complete') {
          clearTimeout(deadline);
          resolve(evt.payload);
        }
      });
    });
    const submit = await rpc.call('prompt.submit', {session_id: sid, text: PROMPT});
    log(`prompt.submit → ${JSON.stringify(submit)}`);
    const complete = await turnDone;
    log(`message.complete status=${complete?.status} text=${JSON.stringify((complete?.text ?? '').slice(0, 80))} usage=${JSON.stringify(complete?.usage ?? null)}`);

    // 7. 事件时间线
    log('事件时间线：');
    for (const e of rpc.timeline.filter(x => x.session_id === sid)) {
      console.log(`  ${e.t}  ${e.type}  ${summarizePayload(e.payload)}`);
    }

    // 8. session.close 清理
    const closed = await rpc.call('session.close', {session_id: sid});
    log(`session.close → ${JSON.stringify(closed)}`);

    // 9. 结构 probe
    try {
      const mo = await rpc.call('model.options');
      const providers = mo?.providers ?? [];
      log(`model.options → model=${mo?.model} provider=${mo?.provider} providers=${providers.length}`);
      if (providers[0]) {
        log('provider 行字段:', Object.keys(providers[0]).join(', '));
        const cur = providers.find(p => p.is_current) ?? providers[0];
        log(`当前 provider=${cur.slug} models[0..2]=${JSON.stringify((cur.models ?? []).slice(0, 3))} total=${cur.total_models}`);
      }
    } catch (e) {
      fail(`model.options probe 失败: ${e.message}`);
    }

    try {
      const asset = await rpc.call('profiles.get_asset', {name: PROFILE, asset: 'avatar'});
      log(
        `profiles.get_asset {name:"${PROFILE}"} → found=${asset?.found}` +
          (asset?.found ? ` mime=${asset.mime} size=${asset.size} data[0..40]=${String(asset.data).slice(0, 40)}…` : '（无头像，UI 用色块兜底）'),
      );
    } catch (e) {
      fail(`profiles.get_asset probe 失败: ${e.message}`);
    }
  } finally {
    rpc.close();
  }

  log('harness 完成');
}

main().catch(e => {
  fail(e.stack || String(e));
  process.exit(1);
});
