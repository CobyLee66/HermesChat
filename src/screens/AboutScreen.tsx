/**
 * AboutScreen — 「关于」页（版本号 / 简介 / GitHub 链接 / 许可证）。
 * 内容主体在共享 panels/AboutPanel（桌面 Modal 同源）。
 */

import React from 'react';
import {StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {AboutPanel} from '../panels/AboutPanel';
import {Colors} from '../components/theme';

export function AboutScreen() {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.container, {paddingBottom: insets.bottom}]}>
      <AboutPanel />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: Colors.bg},
});
