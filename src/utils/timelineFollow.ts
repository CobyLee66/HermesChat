/**
 * timelineFollow — 聊天时间线「贴底跟随」判定纯函数。
 *
 * inverted FlatList 的 offset 即「距视觉底部的距离」，offset≈0 表示停在最新
 * 消息处。流式输出期间内容在视觉底部增长：跟随态必须显式钉底；离开底部后
 * 必须把视口锚定补偿回去（内容在 offset 0 侧生长会把既有内容往新消息方向
 * 推 delta，不补偿则用户阅读位置被拖走）。
 */

/** 距底多小算「在底部」：容忍手势惯性/回弹的过冲 */
export const FOLLOW_THRESHOLD = 32;

/** 距上次 scroll 事件多久以内算「滚动中」：惯性/滚轮动画期间 scroll 事件
 * 持续到达，停滚后超过该静默窗才认为用户已停。 */
export const SCROLL_QUIET_MS = 200;

export function isAtBottom(offset: number): boolean {
  return offset <= FOLLOW_THRESHOLD;
}

/** 内容增长（deltaH > 0）且处于跟随态时钉回底部 */
export function shouldPinToBottom(follow: boolean, deltaH: number): boolean {
  return follow && deltaH > 0;
}

/**
 * 内容增长且非跟随态时需要锚定补偿，须同时满足：
 * - streaming：仅流式增长（视觉底部生长）需要补偿；历史 cell 懒挂载/图片
 *   加载的增长在视觉顶端一侧、不移动视口，补偿反而把用户向前瞬移；
 * - !scrolling：滚动未停时无法区分增长来源（流式中上滑滚入未挂载区时两者
 *   同时发生），且此时视口本来就随手势在动——停滚后的流式增长才补偿，
 *   滚动中的增长交给用户手势与平台 anchoring。
 */
export function shouldRestoreAnchor(
  follow: boolean,
  deltaH: number,
  streaming: boolean,
  scrolling: boolean,
): boolean {
  return !follow && deltaH > 0 && streaming && !scrolling;
}

/**
 * 锚定补偿判定：仅当视口自内容增长起未被移动过（offsetNow === offsetAtGrowth，
 * 即既无用户滚动、平台也没做可见位置调整）才补偿，避免双重补偿或覆盖用户手势。
 * 用 epsilon 容忍浮点/亚像素误差。
 */
export function offsetUntouched(
  offsetNow: number,
  offsetAtGrowth: number,
  epsilon = 0.5,
): boolean {
  return Math.abs(offsetNow - offsetAtGrowth) <= epsilon;
}
