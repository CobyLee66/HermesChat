/**
 * ViewSwitcher — 主页 header 的视图分段切换控件（会话 | 定时任务）。
 * 自绘轻量分段（无第三方依赖），风格对齐 DropdownPill 药丸体系：
 * 未选中段透明底，选中段白底描边 + accent 文字。
 */

import React from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';

import {useT} from '../i18n';
import type {MessageKey} from '../i18n/locales/en';
import {Colors} from './theme';

export type HomeView = 'sessions' | 'cron';

const SEGMENTS: {key: HomeView; labelKey: MessageKey}[] = [
  {key: 'sessions', labelKey: 'view.sessions'},
  {key: 'cron', labelKey: 'view.cron'},
];

export function ViewSwitcher({
  value,
  onChange,
}: {
  value: HomeView;
  onChange: (view: HomeView) => void;
}) {
  const t = useT();
  return (
    <View style={styles.wrap}>
      {SEGMENTS.map(seg => {
        const active = seg.key === value;
        return (
          <TouchableOpacity
            key={seg.key}
            style={[styles.seg, active && styles.segActive]}
            activeOpacity={0.7}
            onPress={() => onChange(seg.key)}
            accessibilityRole="button"
            accessibilityState={{selected: active}}>
            <Text style={[styles.segText, active && styles.segTextActive]}>
              {t(seg.labelKey)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.fillSubtle,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.fillBorder,
    padding: 2,
  },
  seg: {
    borderRadius: 7,
    paddingVertical: 4,
    paddingHorizontal: 12,
  },
  segActive: {
    backgroundColor: Colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.fillBorder,
  },
  segText: {
    fontSize: 14,
    color: Colors.textSecondary,
  },
  segTextActive: {
    color: Colors.accentDark,
    fontWeight: '600',
  },
});
