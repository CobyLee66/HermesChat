import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

import {Colors} from './theme';

/**
 * 顶栏中间标题：主标题 + 可选小字副标题，整体居中。
 * 配合 `title: ''` 使用——原生字符串标题为空时 react-native-screens
 * 会把安卓 toolbar 的 72dp 标题缩进清零，本组件才能占满中间宽度。
 */
export function HeaderTitleView({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string | null;
}) {
  return (
    <View style={styles.wrap} pointerEvents="none">
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      {subtitle ? (
        <Text style={styles.subtitle} numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    maxWidth: '100%',
  },
  title: {fontSize: 15, fontWeight: '600', color: Colors.text},
  subtitle: {fontSize: 11, color: Colors.textSecondary, marginTop: 1},
});
