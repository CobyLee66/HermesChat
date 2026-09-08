import {
  FOLLOW_THRESHOLD,
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

  test('shouldRestoreAnchor：非跟随态且有正增长才补偿', () => {
    expect(shouldRestoreAnchor(false, 1)).toBe(true);
    expect(shouldRestoreAnchor(false, 45)).toBe(true);
    expect(shouldRestoreAnchor(true, 45)).toBe(false);
    expect(shouldRestoreAnchor(false, 0)).toBe(false);
    expect(shouldRestoreAnchor(false, -3)).toBe(false);
  });

  test('offsetUntouched：epsilon 内视为未被移动', () => {
    expect(offsetUntouched(100, 100)).toBe(true);
    expect(offsetUntouched(100.3, 100)).toBe(true);
    expect(offsetUntouched(100, 100.5)).toBe(true);
    expect(offsetUntouched(101, 100)).toBe(false);
    expect(offsetUntouched(99, 100)).toBe(false);
  });
});
