/**
 * sessionSort — 会话列表排序档位。
 *
 * - recent（默认）：「最近消息时间最新在前」。store 里的列表已是该顺序
 *   （服务端 last_active 降序 + 跨库交错，见 projectProfileSessions），
 *   这里原样返回（保持引用稳定）。
 * - created：「会话创建时间最新在前」，纯客户端按 started_at 排。
 */

import type {SessionListRow} from '../rpc/types';

export type SessionSortMode = 'recent' | 'created';

export const SESSION_SORT_STORAGE_KEY = 'hermes.sessionSort.v1';

export function isSessionSortMode(v: unknown): v is SessionSortMode {
  return v === 'recent' || v === 'created';
}

export function sortSessionRows(
  rows: SessionListRow[],
  mode: SessionSortMode,
): SessionListRow[] {
  if (mode === 'recent') {
    return rows;
  }
  return [...rows].sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
}
