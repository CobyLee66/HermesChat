/**
 * breakpoints — 桌面/web 响应式断点（宽度驱动，与是否 Electron 壳无关）。
 *
 * - narrow <900  ：单列（会话 ↔ 聊天切换，同手机流程）
 * - medium 900–1279：两栏（会话列 + 聊天区，Profile 收进顶栏下拉）
 * - wide ≥1280：三栏（Profile 竖条 + 会话列 + 聊天区）
 *
 * Android/iOS 构建不受影响：手机窗口宽度恒为 narrow，且手机仍走原导航栈。
 */

import {useWindowDimensions} from 'react-native';

export type Breakpoint = 'narrow' | 'medium' | 'wide';

export const BREAKPOINT_MEDIUM_MIN = 900;
export const BREAKPOINT_WIDE_MIN = 1280;

export function breakpointFor(width: number): Breakpoint {
  if (width >= BREAKPOINT_WIDE_MIN) {
    return 'wide';
  }
  if (width >= BREAKPOINT_MEDIUM_MIN) {
    return 'medium';
  }
  return 'narrow';
}

export function useBreakpoint(): Breakpoint {
  const {width} = useWindowDimensions();
  return breakpointFor(width);
}
