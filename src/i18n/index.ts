/**
 * i18n — 界面多语言取用层（自研轻量实现，框架契约见 docs/i18n.md）。
 *
 * - 组件渲染路径：`const t = useT();`（订阅语言变化并返回稳定引用，切换语言即重渲染）；
 * - 非组件层（store/rpc/ssh 等）：直接 `t('key', params)`，调用时取当前语言；
 * - 取词回退：当前语言词典缺键 → en 词典 → 键名本身。
 */
import {interpolate} from './interpolate';
import {en, type MessageKey, type MessageParams} from './locales/en';
import {zhCN} from './locales/zh-CN';
import {useLocaleStore} from './localeStore';
import type {Locale} from './resolveLocale';

export {SUPPORTED_LOCALES, resolveLocale} from './resolveLocale';
export type {Locale} from './resolveLocale';
export {
  LOCALE_STORAGE_KEY,
  loadLocalePreference,
  useLocaleStore,
} from './localeStore';
export type {LocaleMode} from './localeStore';
export {interpolate} from './interpolate';
export type {MessageKey, MessageParams} from './locales/en';

const dictionaries: Record<Locale, Record<MessageKey, string>> = {
  en,
  'zh-CN': zhCN,
};

export function t(key: MessageKey, params?: MessageParams): string {
  const locale: Locale = useLocaleStore.getState().locale;
  const raw = dictionaries[locale][key] ?? en[key] ?? key;
  return interpolate(raw, params);
}

/** 组件用：订阅生效语言（切换触发重渲染），返回模块级 t 的稳定引用。 */
export function useT(): typeof t {
  useLocaleStore(s => s.locale);
  return t;
}
