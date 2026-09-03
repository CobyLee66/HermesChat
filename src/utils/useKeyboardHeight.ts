import {useEffect, useState} from 'react';
import {Dimensions, Keyboard} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

/**
 * 输入法面板高度（dp）。Android edge-to-edge + adjustNothing 下
 * KeyboardAvoidingView 拿到的键盘高不可靠，这里直接听 Keyboard 事件手动垫高。
 *
 * 返回 {height, bottomPad}：bottomPad = 键盘弹出时该垫的底部内边距
 * （键盘高度已含系统导航条区域；收起时回到 safe-area 底部 inset）。
 * 真机校准用：didShow 时打日志（event、window 高、inset），便于对不上时调整。
 */
export function useKeyboardHeight(): {height: number; bottomPad: number} {
  const insets = useSafeAreaInsets();
  const [height, setHeight] = useState(0);

  useEffect(() => {
    // 日志不设 __DEV__ 门：真机装的是 release 包，要靠 logcat 校准垫高值
    const log = (tag: string, h: number) => {
      console.log(
        `[kb] ${tag} keyboard=${h} windowH=${Dimensions.get('window').height} ` +
          `insetBottom=${insets.bottom}`,
      );
    };
    const show = Keyboard.addListener('keyboardDidShow', e => {
      const h = e.endCoordinates.height;
      log('didShow', h);
      setHeight(h);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      log('didHide', 0);
      setHeight(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [insets.bottom]);

  // 收起时保留 safe-area 底部，弹出时键盘本身就压在导航条上，直接垫满键盘高
  const bottomPad = height > 0 ? height : insets.bottom;
  return {height, bottomPad};
}
