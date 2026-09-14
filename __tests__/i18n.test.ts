/**
 * i18n 框架单测：语言归一、插值、t() 回退链、localeStore 持久化往返、
 * en/zh-CN 两词典运行时键对齐（scripts/i18n-check.js 的编译外兜底）。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  interpolate,
  resolveLocale,
  SUPPORTED_LOCALES,
  t,
  useLocaleStore,
} from '../src/i18n';
import {en} from '../src/i18n/locales/en';
import {zhCN} from '../src/i18n/locales/zh-CN';
import {
  loadLocalePreference,
  LOCALE_STORAGE_KEY,
} from '../src/i18n/localeStore';

describe('resolveLocale — BCP47 归一', () => {
  it('精确匹配（大小写/下划线归一）', () => {
    expect(resolveLocale('zh-CN')).toBe('zh-CN');
    expect(resolveLocale('zh-cn')).toBe('zh-CN');
    expect(resolveLocale('zh_CN')).toBe('zh-CN');
    expect(resolveLocale('en')).toBe('en');
    expect(resolveLocale('en-US')).toBe('en');
  });

  it('中文变体归入 zh-CN', () => {
    expect(resolveLocale('zh-TW')).toBe('zh-CN');
    expect(resolveLocale('zh-HK')).toBe('zh-CN');
    expect(resolveLocale('zh-Hans-CN')).toBe('zh-CN');
  });

  it('不支持的语言与空值回退 en', () => {
    expect(resolveLocale('fr')).toBe('en');
    expect(resolveLocale('ja-JP')).toBe('en');
    expect(resolveLocale('')).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
    expect(resolveLocale(null)).toBe('en');
  });

  it('支持语言清单', () => {
    expect(SUPPORTED_LOCALES).toEqual(['zh-CN', 'en']);
  });
});

describe('interpolate — 占位符插值', () => {
  it('替换命名占位符', () => {
    expect(interpolate('发送失败: {message}', {message: 'boom'})).toBe(
      '发送失败: boom',
    );
    expect(interpolate('{a} + {b}', {a: 1, b: 2})).toBe('1 + 2');
  });

  it('缺参保留占位符', () => {
    expect(interpolate('hi {name}', {})).toBe('hi {name}');
  });

  it('无参数原样返回', () => {
    expect(interpolate('plain')).toBe('plain');
  });
});

describe('t — 取词与回退', () => {
  afterEach(() => {
    // 恢复全局钉住的 zh-CN（jest.setup）
    useLocaleStore.setState({mode: 'zh-CN', locale: 'zh-CN'});
  });

  it('当前语言取词 + 插值', () => {
    useLocaleStore.setState({mode: 'zh-CN', locale: 'zh-CN'});
    expect(t('chat.sendFailed', {message: 'x'})).toBe('发送失败: x');
    useLocaleStore.setState({mode: 'en', locale: 'en'});
    expect(t('chat.sendFailed', {message: 'x'})).toBe('Send failed: x');
  });

  it('切换语言立即生效（无异步）', () => {
    useLocaleStore.setState({mode: 'zh-CN', locale: 'zh-CN'});
    expect(t('common.ok')).toBe('确定');
    useLocaleStore.setState({locale: 'en'});
    expect(t('common.ok')).toBe('OK');
  });

  it('en 词典是键权威来源（zh-CN 完整对齐）', () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
  });
});

describe('localeStore — 持久化往返', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    useLocaleStore.setState({mode: 'zh-CN', locale: 'zh-CN'});
  });

  it('loadLocalePreference 恢复已存模式', async () => {
    await AsyncStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    await loadLocalePreference();
    expect(useLocaleStore.getState().mode).toBe('en');
    expect(useLocaleStore.getState().locale).toBe('en');
    // 清理
    useLocaleStore.setState({mode: 'zh-CN', locale: 'zh-CN'});
  });

  it('无持久化时保持当前状态不变（跟随系统由初始检测决定）', async () => {
    useLocaleStore.setState({mode: 'auto', locale: 'en'});
    await AsyncStorage.removeItem(LOCALE_STORAGE_KEY);
    await loadLocalePreference();
    expect(useLocaleStore.getState().mode).toBe('auto');
    expect(useLocaleStore.getState().locale).toBe('en');
    // 清理
    useLocaleStore.setState({mode: 'zh-CN', locale: 'zh-CN'});
  });

  it('非法持久化值被忽略', async () => {
    await AsyncStorage.setItem(LOCALE_STORAGE_KEY, 'fr');
    await loadLocalePreference();
    expect(useLocaleStore.getState().mode).toBe('zh-CN');
  });

  it('setMode 切换生效语言并写持久化', async () => {
    useLocaleStore.getState().setMode('en');
    expect(useLocaleStore.getState().locale).toBe('en');
    // setItem 是异步 catch 静默的，微任务后能读到
    await Promise.resolve();
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      LOCALE_STORAGE_KEY,
      'en',
    );
    useLocaleStore.setState({mode: 'zh-CN', locale: 'zh-CN'});
  });
});
