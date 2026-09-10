/**
 * 思考块折叠头预览文本（纯函数）：
 * - 结束后缩略显示开头一行（thinkingHead）
 * - 流式进行中实时刷新尾部窗口（thinkingTail，配合 numberOfLines={2}
 *   呈现最新输出）——slice(-n) 只拷贝窗口长度，不随全文增长变慢
 */

/** 结束态开头预览的最大字符数（numberOfLines={1} 兜底宽度截断） */
const HEAD_MAX = 120;
/** 流式尾部窗口的最大字符数（约两行中文） */
const TAIL_MAX = 200;

export function thinkingHead(text: string): string {
  const firstLine = text.trim().split('\n')[0] ?? '';
  if (firstLine.length <= HEAD_MAX) {
    return firstLine;
  }
  return firstLine.slice(0, HEAD_MAX) + '…';
}

export function thinkingTail(text: string): string {
  if (text.length <= TAIL_MAX) {
    return text;
  }
  return text.slice(-TAIL_MAX);
}
