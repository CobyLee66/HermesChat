import {useEffect, useState} from 'react';
import {Dimensions, Keyboard} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

/**
 * 输入法遮挡高度（dp）。Android edge-to-edge + adjustNothing 下
 * KeyboardAvoidingView 拿到的键盘高不可靠，这里直接听 Keyboard 事件手动垫高。
 *
 * 垫高值用「真实遮挡区」：window 高 − 键盘顶部 screenY（键盘可能少报一个
 * 导航条/其它安全带的高度，直接用 height 会差出小半行）。收起时回到
 * safe-area 底部 inset。
 * 真机校准日志：[kb] didShow height=… screenY=… overlap=… windowH=… insetBottom=…
 */
export function useKeyboardHeight(): {height: number; bottomPad: number} {
  const insets = useSafeAreaInsets();
  const [overlap, setOverlap] = useState(0);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', e => {
      const windowH = Dimensions.get('window').height;
      const {height, screenY} = e.endCoordinates;
      // edge-to-edge 下内容延伸到屏幕底，键盘顶部 screenY 往下全是遮挡区
      const computed = Math.max(0, windowH - screenY);
      console.log(
        `[kb] didShow height=${height} screenY=${screenY} overlap=${computed} ` +
          `windowH=${windowH} insetBottom=${insets.bottom}`,
      );
      setOverlap(computed);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      console.log(
        `[kb] didHide insetBottom=${insets.bottom} windowH=${Dimensions.get('window').height}`,
      );
      setOverlap(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [insets.bottom]);

  // 收起时保留 safe-area 底部；弹出时垫满真实遮挡区（已覆盖导航条区域）
  const bottomPad = overlap > 0 ? overlap : insets.bottom;
  return {height: overlap, bottomPad};
}
