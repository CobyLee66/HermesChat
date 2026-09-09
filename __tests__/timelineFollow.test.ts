import {
  FOLLOW_THRESHOLD,
  SCROLL_QUIET_MS,
  isAtBottom,
  shouldPinToBottom,
  shouldRestoreAnchor,
  offsetUntouched,
} from '../src/utils/timelineFollow';

describe('timelineFollow 贴底跟随判定', () => {
  test('isAtBottom：阈值内算在底部（含 0 与恰好阈值）', () => {
    expect(FOLLOW_THRESHOLD).toBe(32);
    expect(isAtBottom(0)).toBe(true);
    expect(isAtBottom(31.9)).toBe(true);
    expect(isAtBottom(FOLLOW_THRESHOLD)).toBe(true);
    expect(isAtBottom(FOLLOW_THRESHOLD + 0.1)).toBe(false);
    expect(isAtBottom(600)).toBe(false);
  });

  test('shouldPinToBottom：跟随态且有正增长才钉底', () => {
    expect(shouldPinToBottom(true, 1)).toBe(true);
    expect(shouldPinToBottom(true, 120)).toBe(true);
    expect(shouldPinToBottom(false, 120)).toBe(false);
    // 内容无变化/收缩（图片卸载等）不钉底
    expect(shouldPinToBottom(true, 0)).toBe(false);
    expect(shouldPinToBottom(true, -5)).toBe(false);
    expect(shouldPinToBottom(false, 0)).toBe(false);
  });

  test('shouldRestoreAnchor：非跟随 + 正增长 + 流式中 + 停滚才补偿', () => {
    // 流式增长（视觉底部生长）且用户已停滚：补偿
    expect(shouldRestoreAnchor(false, 1, true, false)).toBe(true);
    expect(shouldRestoreAnchor(false, 45, true, false)).toBe(true);
    expect(shouldRestoreAnchor(true, 45, true, false)).toBe(false);
    expect(shouldRestoreAnchor(false, 0, true, false)).toBe(false);
    expect(shouldRestoreAnchor(false, -3, true, false)).toBe(false);
    // 非流式增长（历史 cell 挂载/图片加载，视觉顶端生长）不补偿：
    // 补偿会把用户向前瞬移，是首次上滚抖动的根因
    expect(shouldRestoreAnchor(false, 45, false, false)).toBe(false);
    expect(shouldRestoreAnchor(true, 45, false, false)).toBe(false);
    // 滚动未停时不补偿：流式中上滑滚入未挂载区，流式增长与挂载增长无法
    // 区分，且视口本就随手势在动——停滚后的流式增长才补偿
    expect(shouldRestoreAnchor(false, 45, true, true)).toBe(false);
    expect(SCROLL_QUIET_MS).toBe(200);
  });

  test('offsetUntouched：epsilon 内视为未被移动', () => {
    expect(offsetUntouched(100, 100)).toBe(true);
    expect(offsetUntouched(100.3, 100)).toBe(true);
    expect(offsetUntouched(100, 100.5)).toBe(true);
    expect(offsetUntouched(101, 100)).toBe(false);
    expect(offsetUntouched(99, 100)).toBe(false);
  });
});
