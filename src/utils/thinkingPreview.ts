/**
 * 思考块折叠头预览文本（纯函数）：
 * - 结束后缩略显示开头一行（thinkingHead）
 * - 流式进行中实时刷新尾部窗口（thinkingTail，配合 numberOfLines={2}
 *   呈现最新输出）
 *
 * ⚠ 截断方向陷阱：RN Text 的 numberOfLines 默认 ellipsizeMode="tail"，
 * 显示字符串开头、省略末尾；且 Android 多行只支持 tail、web(line-clamp)
 * 也只有尾部省略——三端都无法靠 ellipsizeMode 锚定尾部。因此 thinkingTail
 * 必须按可用宽度把窗口收敛到「恰好放得下两行」：截断永不触发，最新输出
 * 才始终可见。窗口长度只与宽度预算相关，不随全文增长变慢。
 */

/** 结束态开头预览的最大字符数（numberOfLines={1} 兜底宽度截断） */
const HEAD_MAX = 120;
/** 无宽度信息时的兜底流式窗口字符数（布局完成前的短暂回退） */
const TAIL_MAX = 200;
/** 流式预览字号：与 ThinkingBlock styles.liveBody.fontSize 保持一致 */
const LIVE_FONT_SIZE = 12;
/** 宽字形估算宽度：CJK、全角标点、emoji 等（≈ 字号） */
const WIDE_CHAR_PX = LIVE_FONT_SIZE;
/** 窄字形平均宽度：ASCII 字母/数字/空格（取偏保守上界防溢出截尾） */
const NARROW_CHAR_PX = 7;
/** 宽度预算安全余量：吸收估算偏窄的字形（破折号/制表符/emoji 等） */
const SAFETY_PX = WIDE_CHAR_PX * 2;
/** 预切尾段上限：宽度游走只触及尾部，先切一段避免 O(全文) 扫描 */
const PRE_SLICE = 2000;

export function thinkingHead(text: string): string {
  const firstLine = text.trim().split('\n')[0] ?? '';
  if (firstLine.length <= HEAD_MAX) {
    return firstLine;
  }
  return firstLine.slice(0, HEAD_MAX) + '…';
}

/**
 * 流式尾部窗口：
 * - 无 maxWidthPx（布局完成前）：退回固定字符数窗口
 * - 有 maxWidthPx：从尾部向前累加估算字形宽度，预算 = 两行宽度 − 安全
 *   余量，返回必然放得下两行的尾部子串；换行归一化为空格，避免强制换行
 *   吃掉行数预算导致最新输出被 numberOfLines 的 tail 截断吃掉
 */
export function thinkingTail(text: string, maxWidthPx?: number): string {
  const flat = text.slice(-PRE_SLICE).replace(/\n+/g, ' ');
  if (maxWidthPx === undefined || maxWidthPx <= 0) {
    return flat.length <= TAIL_MAX ? flat : flat.slice(-TAIL_MAX);
  }
  const budget = maxWidthPx * 2 - SAFETY_PX;
  let acc = 0;
  let start = flat.length;
  while (start > 0) {
    const w =
      flat.charCodeAt(start - 1) >= 0x2000 ? WIDE_CHAR_PX : NARROW_CHAR_PX;
    if (acc + w > budget) {
      break;
    }
    acc += w;
    start -= 1;
  }
  return flat.slice(start);
}
