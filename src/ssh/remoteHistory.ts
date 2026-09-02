/**
 * remoteHistory.ts — foreign 会话（multiplex 大库里属于其它 profile 的会话）
 * 的历史只读投影，经 SSH exec sqlite3 直接读库。
 *
 * 为什么不用 session.history RPC：该 RPC 只查 gateway 内存中的 live 会话
 * （`_sess_nowait` 直查 `_sessions` 字典，key 是 8 位 live sid），对
 * session.list 返回的持久化 id 一律 4001（已实测 + 源码确认）。存储会话的
 * 历史官方路径只有 session.resume（会 attach 出宿主 profile 人格的 agent），
 * 与本功能"只读展示、发送时才派生"的语义冲突，故走只读 sqlite。
 *
 * content 以 hex 传输（避免换行/引号/UTF-8 在 shell 管道里的转义问题），
 * 客户端解码。不取 tool 行（工具结果可能极大，只读视图不渲染工具卡）。
 */

import type {ProjectedMessage} from '../rpc/types';
import type {ExecRemoteFn} from './execRemote';

/** 单次拉取上限（行数），防止巨型会话占爆 exec 输出。 */
export const HISTORY_LIMIT = 800;

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** SQL 字符串字面量转义（单引号双写）。 */
function sqlQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * 历史查询：每行 `role\t hex(content)\t timestamp\t display_kind`，按行序。
 * 跳过非 active 行与 hidden/compaction 展示标记行。
 */
export function buildHistoryCommand(
  dbPath: string,
  sessionId: string,
  limit: number = HISTORY_LIMIT,
): string {
  return (
    `sqlite3 ${shQuote(`file:${dbPath}?mode=ro`)} ` +
    `"SELECT role || char(9) || hex(COALESCE(content,'')) || char(9) ||` +
    ` COALESCE(timestamp,0) || char(9) || COALESCE(display_kind,'')` +
    ` FROM messages WHERE session_id=${sqlQuote(sessionId)}` +
    ` AND role IN ('user','assistant','system')` +
    ` AND COALESCE(active,1)=1` +
    ` AND COALESCE(display_kind,'') NOT IN ('hidden','compaction')` +
    ` ORDER BY id LIMIT ${Math.max(1, Math.floor(limit))}"`
  );
}

/** hex → UTF-8 字符串（RN Hermes 0.74+ 有 TextDecoder；兜底百分号解码）。 */
export function hexToUtf8(hex: string): string {
  if (!hex) {
    return '';
  }
  const n = Math.floor(hex.length / 2);
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  // RN 的 TS lib 无 TextDecoder 类型声明，从 globalThis 结构取用
  const Decoder = (
    globalThis as {
      TextDecoder?: new (
        label?: string,
        options?: {fatal?: boolean},
      ) => {decode(input: Uint8Array): string};
    }
  ).TextDecoder;
  if (Decoder) {
    return new Decoder('utf-8', {fatal: false}).decode(bytes);
  }
  let s = '';
  for (let i = 0; i < n; i++) {
    s += `%${bytes[i].toString(16).padStart(2, '0')}`;
  }
  try {
    return decodeURIComponent(s);
  } catch {
    return '';
  }
}

/**
 * content 可能是 JSON parts 数组（视觉 turn）：拍平为纯文本
 * （text 类 part 取文本，image part 取其 URL 独立成行，与服务端
 * `_coerce_message_text` 的拍平方式一致）。非 JSON 按原文返回。
 */
export function coerceContentText(content: string): string {
  const t = content.trim();
  if (!t.startsWith('[') && !t.startsWith('{')) {
    return content;
  }
  try {
    const v: unknown = JSON.parse(t);
    if (Array.isArray(v)) {
      const lines: string[] = [];
      for (const part of v) {
        if (!part || typeof part !== 'object') {
          continue;
        }
        const p = part as Record<string, unknown>;
        const kind = p.type;
        if (kind === 'text' || kind === 'input_text' || kind === 'output_text') {
          const s = String(p.text ?? p.content ?? '');
          if (s) {
            lines.push(s);
          }
        } else if (
          kind === 'image_url' ||
          kind === 'input_image' ||
          kind === 'image'
        ) {
          const iu = p.image_url;
          const url =
            typeof iu === 'object' && iu !== null
              ? (iu as {url?: unknown}).url
              : (iu ?? p.url);
          if (url) {
            lines.push(String(url));
          }
        }
      }
      return lines.join('\n');
    }
    if (v && typeof v === 'object') {
      const text = (v as {text?: unknown}).text;
      if (typeof text === 'string') {
        return text;
      }
    }
  } catch {
    // 非 JSON，按原文
  }
  return content;
}

/** 解析历史输出 → ProjectedMessage[]（role 已限 user/assistant/system）。 */
export function parseHistoryOutput(stdout: string): ProjectedMessage[] {
  const out: ProjectedMessage[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const cols = line.split('\t');
    if (cols.length < 2) {
      continue;
    }
    const role = cols[0] as ProjectedMessage['role'];
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      continue;
    }
    const text = coerceContentText(hexToUtf8(cols[1])).trim();
    if (!text) {
      continue;
    }
    const ts = Number(cols[2]);
    const dk = cols[3];
    out.push({
      role,
      text,
      ...(Number.isFinite(ts) && ts > 0 ? {timestamp: ts} : null),
      ...(dk ? {display_kind: dk} : null),
    });
  }
  return out;
}

/**
 * fork 种子：官方 `_coerce_seed_history` 只收 user/assistant/system +
 * 非空 text/content；展示用标记行（display_kind）不进模型上下文。
 */
export function toSeedMessages(
  messages: ProjectedMessage[],
): {role: string; text: string}[] {
  const seed: {role: string; text: string}[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') {
      continue;
    }
    if (m.display_kind) {
      continue;
    }
    const text = (m.text ?? '').trim();
    if (!text) {
      continue;
    }
    seed.push({role: m.role, text});
  }
  return seed;
}

/**
 * 拉取 foreign 会话历史。exec/sqlite 失败时抛错（调用方友好提示），
 * 与 namespaceMap 的静默降级不同——这里是用户显式打开会话，需要知道成败。
 */
export async function fetchRemoteHistory(
  exec: ExecRemoteFn,
  dbPath: string,
  sessionId: string,
): Promise<ProjectedMessage[]> {
  const res = await exec(buildHistoryCommand(dbPath, sessionId), 30000);
  if (res.exitCode !== 0) {
    throw new Error(
      `读取远端会话历史失败（sqlite3 exit=${res.exitCode}）：${res.stderr.slice(0, 120)}`,
    );
  }
  return parseHistoryOutput(res.stdout);
}
