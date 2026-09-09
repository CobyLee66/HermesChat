/**
 * 聊天记录查找（会话右上角菜单入口）：对 chat store 已加载的 TimelineItem
 * 做前端文本搜索（历史全量在内存，无分页）。
 *
 * 匹配范围刻意只收「可见对话文本」——用户消息、助手 text/error 块、系统灰条；
 * thinking/reasoning/tool 卡不搜：它们受「显示工具与思考」开关控制且属中间
 * 过程，命中后跳转过去看不到匹配反而困惑。一条消息多个块命中只记一个 hit，
 * 返回保持时间正序（items 原顺序），供 ↑/↓ 循环跳转与当前项高亮定位。
 */

import type {TimelineItem} from '../rpc/types';

/** 抽取一条消息参与匹配的文本（无则返回 null，不参与搜索） */
function itemSearchText(item: TimelineItem): string | null {
  switch (item.kind) {
    case 'user':
      return item.text || null;
    case 'assistant':
      return item.blocks.some(b => b.type === 'text' || b.type === 'error')
        ? item.blocks
            .map(b => (b.type === 'text' || b.type === 'error' ? b.text : ''))
            .join('\n')
        : null;
    case 'system':
      return item.text || null;
    default:
      // approval/clarify 卡片无正文可搜
      return null;
  }
}

/** 返回命中 query 的消息 id 列表（时间正序）；query 去空白后为空即无命中 */
export function searchTimeline(items: TimelineItem[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [];
  }
  const hits: string[] = [];
  for (const item of items) {
    const text = itemSearchText(item);
    if (text !== null && text.toLowerCase().includes(q)) {
      hits.push(item.id);
    }
  }
  return hits;
}
