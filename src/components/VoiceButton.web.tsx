/**
 * web 变体（vite resolve.extensions 让 .web.tsx 优先；Metro 默认平台不含 web，
 * 原生构建仍用 VoiceButton.tsx，tsc 类型检查也以原文件为准）。
 * 浏览器无录音链路（PermissionsAndroid/RNFS 均为打桩，录音走原生 HermesAudio（web 无）），
 * 渲染禁用态占位（纯图标，与面板其他磁贴风格一致），保持附件面板布局一致。
 */

import React from 'react';
import {StyleSheet, View} from 'react-native';

import {IconImage} from './icons';

interface Props {
  profile: string;
  onText: (text: string) => void;
}

export function VoiceButton(_props: Props) {
  return (
    <View style={styles.tile}>
      <IconImage name="microphone" size={26} />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 88,
    height: 56,
    opacity: 0.35,
  },
});
