/**
 * deviceLocale — 原生端系统语言检测（web 构建解析 deviceLocale.web.ts，不进 web 包）。
 * Android 走内置 I18nManager.localeIdentifier（如 zh_CN）；
 * iOS 走 SettingsManager（AppleLocale / AppleLanguages），iOS 工程未启用，保留探测以备后用。
 * 取不到时返回 undefined，由 resolveLocale 兜底 en。
 */
import {NativeModules} from 'react-native';

interface LocaleNativeModules {
  I18nManager?: {localeIdentifier?: string};
  SettingsManager?: {
    settings?: {AppleLocale?: string; AppleLanguages?: readonly string[]};
  };
}

const modules = NativeModules as unknown as LocaleNativeModules;

export function detectSystemLocale(): string | undefined {
  const android = modules.I18nManager?.localeIdentifier;
  if (android) {
    return android;
  }
  const ios = modules.SettingsManager?.settings;
  return ios?.AppleLocale || ios?.AppleLanguages?.[0];
}
