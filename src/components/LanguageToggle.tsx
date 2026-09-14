/**
 * LanguageToggle — 最小语言切换入口：点击在 跟随系统 → 简体中文 → English 间循环。
 * 选择经 localeStore 持久化（hermes.locale.v1），即时生效。
 * 原生端挂 ProfileList header（退出按钮左侧），桌面端挂 ProfileRail 底部。
 */
import React from 'react';
import {Text, TouchableOpacity, type TextStyle} from 'react-native';

import {useT} from '../i18n';
import {useLocaleStore, type LocaleMode} from '../i18n/localeStore';
import type {MessageKey} from '../i18n/locales/en';

const MODE_ORDER: LocaleMode[] = ['auto', 'zh-CN', 'en'];

const MODE_LABEL_KEY: Record<LocaleMode, MessageKey> = {
  auto: 'settings.lang.auto',
  'zh-CN': 'settings.lang.zh',
  en: 'settings.lang.en',
};

export function LanguageToggle({style}: {style?: TextStyle}) {
  const t = useT();
  const mode = useLocaleStore(s => s.mode);
  const setMode = useLocaleStore(s => s.setMode);

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      accessibilityLabel={t('settings.language')}
      hitSlop={6}
      onPress={() => {
        const next =
          MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length];
        setMode(next);
      }}>
      <Text style={style}>{t(MODE_LABEL_KEY[mode])}</Text>
    </TouchableOpacity>
  );
}
