/**
 * useKeyboardHeight 对账 watchdog 测试（D050）。
 *
 * 覆盖：didShow/didHide 正常路径；keyboardDidHide 被 RN 原生状态机漏发时，
 * 原生 isImeVisible 轮询对账收回垫高；关键盘后迟到 spurious didShow 同样被
 * 收回；无原生模块 / 非 Android 平台不轮询（维持纯事件路径不炸）。
 *
 * 事件注入：Keyboard 走 NativeEventEmitter（Android 传 null → DeviceEventEmitter），
 * 测试直接 DeviceEventEmitter.emit 合成键盘事件。
 */
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {
  DeviceEventEmitter,
  Dimensions,
  NativeModules,
  Platform,
} from 'react-native';
import {SafeAreaInsetsContext} from 'react-native-safe-area-context';

import {useKeyboardHeight} from '../src/utils/useKeyboardHeight';

const INSETS = {top: 0, bottom: 20, left: 0, right: 0};
const KB_HEIGHT = 300;
// 与 useKeyboardHeight.ts 的 RECONCILE_INTERVAL_MS 一致（模块私有不导出）
const INTERVAL_MS = 400;

let latest: {height: number; bottomPad: number};

function Probe(): null {
  latest = useKeyboardHeight();
  return null;
}

/** 合成 keyboardDidShow 事件：overlap = windowH − screenY = KB_HEIGHT */
function didShowPayload() {
  const windowH = Dimensions.get('window').height;
  return {
    duration: 0,
    easing: 'keyboard',
    endCoordinates: {
      height: KB_HEIGHT,
      screenX: 0,
      screenY: windowH - KB_HEIGHT,
      width: 400,
    },
  };
}

async function mount(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <SafeAreaInsetsContext.Provider value={INSETS}>
        <Probe />
      </SafeAreaInsetsContext.Provider>,
    );
  });
  return renderer;
}

async function emitKeyboard(eventName: string, payload?: unknown): Promise<void> {
  await act(async () => {
    DeviceEventEmitter.emit(eventName, payload);
    await Promise.resolve();
  });
}

async function advanceTimers(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    // 轮询回调是 promise 链，排空微任务让 setState 落地
    await Promise.resolve();
    await Promise.resolve();
  });
}

type NativeMock = {isImeVisible: jest.Mock};
function setNativeModule(mock: NativeMock | undefined): void {
  (NativeModules as unknown as Record<string, unknown>).HermesKeyboard = mock;
}

describe('useKeyboardHeight IME 对账 watchdog', () => {
  const originalOs = Platform.OS;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    (Platform as {OS: string}).OS = originalOs;
    setNativeModule(undefined);
    logSpy.mockRestore();
    jest.useRealTimers();
  });

  function useAndroid(): void {
    (Platform as {OS: string}).OS = 'android';
  }

  it('正常路径：didShow 垫高 → didHide 收回（收起后不再轮询）', async () => {
    useAndroid();
    const native: NativeMock = {isImeVisible: jest.fn().mockResolvedValue(true)};
    setNativeModule(native);
    const renderer = await mount();

    await emitKeyboard('keyboardDidShow', didShowPayload());
    expect(latest.height).toBe(KB_HEIGHT);
    expect(latest.bottomPad).toBe(KB_HEIGHT);

    // 键盘 believed-open 期间轮询，原生报可见则保持垫高
    await advanceTimers(INTERVAL_MS * 2);
    expect(latest.height).toBe(KB_HEIGHT);
    const callsAfterOpen = native.isImeVisible.mock.calls.length;
    expect(callsAfterOpen).toBeGreaterThan(0);

    await emitKeyboard('keyboardDidHide');
    expect(latest.height).toBe(0);
    expect(latest.bottomPad).toBe(INSETS.bottom);

    // 收起后 watchdog 停止：不再产生新的原生查询
    await advanceTimers(INTERVAL_MS * 2);
    expect(native.isImeVisible.mock.calls.length).toBe(callsAfterOpen);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('keyboardDidHide 漏发：原生报不可见，watchdog 收回垫高', async () => {
    useAndroid();
    const native: NativeMock = {isImeVisible: jest.fn().mockResolvedValue(false)};
    setNativeModule(native);
    const renderer = await mount();

    await emitKeyboard('keyboardDidShow', didShowPayload());
    expect(latest.height).toBe(KB_HEIGHT);

    await advanceTimers(INTERVAL_MS);
    expect(latest.height).toBe(0);
    expect(latest.bottomPad).toBe(INSETS.bottom);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('[kb] reconcile'),
    );

    await act(async () => {
      renderer.unmount();
    });
  });

  it('关键盘后迟到的 spurious didShow：重新撑起后仍被 watchdog 收回', async () => {
    useAndroid();
    const native: NativeMock = {isImeVisible: jest.fn().mockResolvedValue(false)};
    setNativeModule(native);
    const renderer = await mount();

    await emitKeyboard('keyboardDidShow', didShowPayload());
    await emitKeyboard('keyboardDidHide');
    expect(latest.height).toBe(0);

    // 事件已丢/乱序场景：关闭后迟到的 didShow 把 padding 再次撑起
    await emitKeyboard('keyboardDidShow', didShowPayload());
    expect(latest.height).toBe(KB_HEIGHT);

    await advanceTimers(INTERVAL_MS);
    expect(latest.height).toBe(0);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('无原生模块（web/桌面/未注册）：不轮询不炸，维持纯事件路径', async () => {
    useAndroid();
    setNativeModule(undefined);
    const renderer = await mount();

    await emitKeyboard('keyboardDidShow', didShowPayload());
    expect(latest.height).toBe(KB_HEIGHT);

    await advanceTimers(INTERVAL_MS * 2);
    expect(latest.height).toBe(KB_HEIGHT);

    // 事件路径仍然有效
    await emitKeyboard('keyboardDidHide');
    expect(latest.height).toBe(0);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('非 Android 平台：不发起原生轮询', async () => {
    (Platform as {OS: string}).OS = 'ios';
    const native: NativeMock = {isImeVisible: jest.fn().mockResolvedValue(false)};
    setNativeModule(native);
    const renderer = await mount();

    await emitKeyboard('keyboardDidShow', didShowPayload());
    await advanceTimers(INTERVAL_MS * 2);
    expect(native.isImeVisible).not.toHaveBeenCalled();
    expect(latest.height).toBe(KB_HEIGHT);

    await act(async () => {
      renderer.unmount();
    });
  });
});
