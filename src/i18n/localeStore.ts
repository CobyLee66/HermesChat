/**
 * localeStore — 语言状态：跟随系统（auto）或手动指定，附持久化。
 * 持久化只存 mode；生效 locale = auto 时由系统语言解析，否则即 mode。
 * 持久化对（写后即存 + 启动恢复）循 sessions.ts sortMode 先例，key 沿用
 * `hermes.<domain>.v1` 惯例。初始 locale 在建 store 时同步解析（首帧即正确语言）。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {create} from 'zustand';

import {detectSystemLocale} from './deviceLocale';
import {resolveLocale, type Locale} from './resolveLocale';

export const LOCALE_STORAGE_KEY = 'hermes.locale.v1';
export type LocaleMode = 'auto' | Locale;

interface LocaleStore {
  /** 语言模式：'auto' = 跟随系统 */
  mode: LocaleMode;
  /** 生效语言（t() 实际取用的） */
  locale: Locale;
  setMode(mode: LocaleMode): void;
}

function effectiveLocale(mode: LocaleMode): Locale {
  return mode === 'auto' ? resolveLocale(detectSystemLocale()) : mode;
}

export const useLocaleStore = create<LocaleStore>(set => ({
  mode: 'auto',
  locale: effectiveLocale('auto'),
  setMode: mode => {
    set({mode, locale: effectiveLocale(mode)});
    AsyncStorage.setItem(LOCALE_STORAGE_KEY, mode).catch(() => {
      // 持久化失败静默：下次启动回退跟随系统
    });
  },
}));

/** 启动恢复语言偏好（App 挂载时调用，进首屏前完成，循 sortMode 恢复先例）。 */
export async function loadLocalePreference(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(LOCALE_STORAGE_KEY);
    if (raw === 'auto' || raw === 'zh-CN' || raw === 'en') {
      useLocaleStore.setState({mode: raw, locale: effectiveLocale(raw)});
    }
  } catch {
    // 读失败保持初始值（跟随系统）
  }
}
