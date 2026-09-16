import {useEffect, useRef, useState} from 'react';
import {Dimensions, Keyboard, NativeModules, Platform} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

/** 原生 IME 对账模块：仅 Android 注册（见 HermesKeyboardModule.kt）。 */
interface HermesKeyboardNativeModule {
  isImeVisible(): Promise<boolean>;
}

/** 对账轮询间隔（ms）：键盘 believed-open 期间用原生真值核对缓存状态。 */
const RECONCILE_INTERVAL_MS = 400;

/**
 * 输入法遮挡高度（dp）。Android edge-to-edge + adjustNothing 下
 * KeyboardAvoidingView 拿到的键盘高不可靠，这里直接听 Keyboard 事件手动垫高。
 *
 * 垫高值用「真实遮挡区」：window 高 − 键盘顶部 screenY（键盘可能少报一个
 * 导航条/其它安全带的高度，直接用 height 会差出小半行）。收起时回到
 * safe-area 底部 inset。
 * 真机校准日志：[kb] didShow height=… screenY=… overlap=… windowH=… insetBottom=…
 *
 * 收回依赖 keyboardDidHide，而该事件来自 RN 原生 global-layout 缓存状态机——
 * agent 流式输出期间布局高密度失效时真机可漏发，padding 会卡在键盘高度
 * （2026-09-16 用户报障）。adjustNothing 下 JS 侧无键盘真实可见性可对账
 * （Dimensions 不变、Keyboard.isVisible 同源缓存），故 believed-open 期间
 * 用原生 HermesKeyboard.isImeVisible 轮询对账，原生报不可见即收回垫高。
 */
export function useKeyboardHeight(): {height: number; bottomPad: number} {
  const insets = useSafeAreaInsets();
  const [overlap, setOverlap] = useState(0);

  // 监听器闭包经 ref 读最新 inset；订阅挂载期只挂一次（此前随 insets.bottom
  // 重挂，重挂窗口错过键盘事件即丢收回时机）
  const insetsBottomRef = useRef(insets.bottom);
  insetsBottomRef.current = insets.bottom;

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', e => {
      const windowH = Dimensions.get('window').height;
      const {height, screenY} = e.endCoordinates;
      // edge-to-edge 下内容延伸到屏幕底，键盘顶部 screenY 往下全是遮挡区
      const computed = Math.max(0, windowH - screenY);
      console.log(
        `[kb] didShow height=${height} screenY=${screenY} overlap=${computed} ` +
          `windowH=${windowH} insetBottom=${insetsBottomRef.current}`,
      );
      setOverlap(computed);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      console.log(
        `[kb] didHide insetBottom=${insetsBottomRef.current} windowH=${Dimensions.get('window').height}`,
      );
      setOverlap(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // 对账 watchdog：仅 Android 且垫高未收回时轮询（关键盘后迟到的 didShow
  // 重新撑起 padding 的场景同样被此收回）
  const open = overlap > 0;
  useEffect(() => {
    if (!open) {
      return;
    }
    const native =
      Platform.OS === 'android'
        ? (NativeModules.HermesKeyboard as HermesKeyboardNativeModule | undefined)
        : undefined;
    if (!native?.isImeVisible) {
      return;
    }
    const id = setInterval(() => {
      native
        .isImeVisible()
        .then(visible => {
          if (!visible) {
            console.log('[kb] reconcile: native ime invisible -> overlap=0');
            setOverlap(0);
          }
        })
        .catch(() => {});
    }, RECONCILE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [open]);

  // 收起时保留 safe-area 底部；弹出时垫满真实遮挡区（已覆盖导航条区域）
  const bottomPad = overlap > 0 ? overlap : insets.bottom;
  return {height: overlap, bottomPad};
}
