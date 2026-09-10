/**
 * 会话 REST 只读端点（/api/sessions/*）。
 *
 * 与 /api/cron/* 同端口同进程（dashboard 9119）、同 token 鉴权
 * （X-Hermes-Session-Token 中间件放行）。当前只有 cron 运行详情在用：
 * 运行记录是 source=cron 的持久化会话，只读展示其内容不能走
 * session.resume（会挂起宿主 profile 的 agent，副作用）；该端点由服务端
 * read_only 打库，自动解析压缩链（resolve_resume_session_id），默认返回
 * 最新 500 条按时间序。
 *
 * 注意：返回的是 messages 表原始行（role/content/timestamp/display_kind…），
 * 不是 gateway WS 侧的投影（无 name/args 工具结构），故 tool 行不渲染——
 * 与 foreign 只读视图（remoteHistory.ts 只取 user/assistant/system）同口径。
 */

import {cronFetch} from './cron';
import type {ProjectedMessage} from './types';
import {coerceContentText} from '../ssh/remoteHistory';

/** GET /api/sessions/{id}/messages 返回的原始行（只声明用到的字段）。 */
export interface RawSessionMessageRow {
  role?: string;
  content?: string | null;
  timestamp?: number | null;
  display_kind?: string | null;
  /** 压缩摘要的服务端展示投影（有值时 content 是物理全文，展示用它） */
  display_content?: string | null;
  [key: string]: unknown;
}

export interface SessionMessagesResult {
  session_id: string;
  messages: RawSessionMessageRow[];
  pagination: {
    limit: number;
    offset: number;
    order: string;
    returned: number;
  };
}

/** 只读拉取一个持久化会话的消息（默认最新 500 条，时间正序）。 */
export function getSessionMessages(
  httpUrl: string,
  token: string,
  sessionId: string,
  profile?: string,
): Promise<SessionMessagesResult> {
  const qs = profile ? `?profile=${encodeURIComponent(profile)}` : '';
  return cronFetch<SessionMessagesResult>(
    httpUrl,
    token,
    `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs}`,
  );
}

/**
 * 原始行 → 只读投影（ProjectedMessage[]，时间正序）：
 * - 只留 user/assistant/system（tool 行不渲染，见文件头）；
 * - display_kind='hidden' 跳过；压缩摘要行取 display_content 作 system 文本；
 * - content 可能是 JSON parts 数组（视觉 turn），经 coerceContentText 拍平；
 * - 空文本跳过。
 */
export function projectRunMessages(
  rows: RawSessionMessageRow[],
): ProjectedMessage[] {
  const out: ProjectedMessage[] = [];
  for (const row of rows ?? []) {
    const role = row.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      continue;
    }
    if (row.display_kind === 'hidden') {
      continue;
    }
    const isCompactionSummary =
      row.display_content != null && row.display_content !== '';
    const raw = isCompactionSummary ? row.display_content! : (row.content ?? '');
    const text = coerceContentText(String(raw)).trim();
    if (!text) {
      continue;
    }
    const ts = Number(row.timestamp);
    out.push({
      role: isCompactionSummary ? 'system' : role,
      text,
      ...(Number.isFinite(ts) && ts > 0 ? {timestamp: ts} : null),
    });
  }
  return out;
}
