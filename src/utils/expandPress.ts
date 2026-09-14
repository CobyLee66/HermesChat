/**
 * 卡片展开/收起的按压 props 工厂（ThinkingBlock / ToolCallCard 的折叠头共用）。
 *
 * 平台按压契约差异：
 * - 原生（RN Pressability）：touchdown 即锁定 responder，release 时无条件触发
 *   onPress（不做边界检查）——流式内容增长把卡片顶走不影响按压，维持 onPress。
 * - web/桌面（RNW PressResponder）：onPress 走 DOM click 事件，浏览器要求
 *   mousedown 与 mouseup 落在同一元素才派发——流式钉底期间卡片随内容增长
 *   不断上移，按下→抬起之间 click 永不触发（实证：流式中真实鼠标点击展开
 *   6/6 失败，卡片结构性点不开）。故 web 端改为 onPressIn（responder grant，
 *   即 mousedown 落点瞬间、内容尚未移动时）切换；onPress 仅放行键盘与程序化
 *   click（UIEvent.detail 恒 0，鼠标 click ≥ 1），避免与 onPressIn 双触发。
 */

import {Platform} from 'react-native';
import type {GestureResponderEvent} from 'react-native';

export function expandToggleProps(toggle: () => void): {
  onPress?: (e: GestureResponderEvent) => void;
  onPressIn?: (e: GestureResponderEvent) => void;
} {
  if (Platform.OS !== 'web') {
    return {onPress: toggle};
  }
  return {
    onPressIn: toggle,
    onPress: e => {
      const detail = (e.nativeEvent as unknown as {detail?: number}).detail;
      if (detail === 0) {
        toggle();
      }
    },
  };
}
