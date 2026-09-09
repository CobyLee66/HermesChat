/**
 * 会话列表文本搜索（SessionListPanel 工具栏搜索按钮展开的搜索栏）。
 * 纯客户端过滤：按会话标题 + 摘要不区分大小写匹配；空标题行按界面实际
 * 显示文案「未命名会话」参与匹配（搜「未命名」应能命中空标题会话）。
 */

import type {SessionListRow} from '../rpc/types';

/** 单行匹配（query 先去首尾空白，空串恒不过滤） */
export function sessionMatchesQuery(row: SessionListRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) {
    return true;
  }
  const title = (row.title || '未命名会话').toLowerCase();
  const preview = (row.preview || '').toLowerCase();
  return title.includes(q) || preview.includes(q);
}

/** 按关键词过滤会话行（保持入参顺序，排序由调用方在过滤后做） */
export function filterSessionsByQuery(
  rows: SessionListRow[],
  query: string,
): SessionListRow[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return rows;
  }
  return rows.filter(row => sessionMatchesQuery(row, q));
}
