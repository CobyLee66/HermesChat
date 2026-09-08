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

export function isAtBottom(offset: number): boolean {
  return offset <= FOLLOW_THRESHOLD;
}

/** 内容增长（deltaH > 0）且处于跟随态时钉回底部 */
export function shouldPinToBottom(follow: boolean, deltaH: number): boolean {
  return follow && deltaH > 0;
}

/** 内容增长且非跟随态时需要锚定补偿 */
export function shouldRestoreAnchor(
  follow: boolean,
  deltaH: number,
): boolean {
  return !follow && deltaH > 0;
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
