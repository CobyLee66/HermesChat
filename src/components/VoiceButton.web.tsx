/**
 * web 变体（vite resolve.extensions 让 .web.tsx 优先；Metro 默认平台不含 web，
 * 原生构建仍用 VoiceButton.tsx，tsc 类型检查也以原文件为准）。
 * 浏览器无录音链路（PermissionsAndroid/audio-recorder-player/RNFS 均为打桩），
 * 渲染禁用态占位，保持附件面板布局一致。
 */

import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

import {Colors} from './theme';

interface Props {
  profile: string;
  onText: (text: string) => void;
}

export function VoiceButton(_props: Props) {
  return (
    <View style={styles.tile}>
      <Text style={styles.icon}>🎤</Text>
      <Text style={styles.label} numberOfLines={1}>
        语音输入（仅手机）
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {alignItems: 'center', width: 88, paddingVertical: 6, opacity: 0.35},
  icon: {fontSize: 26, marginBottom: 4},
  label: {fontSize: 12, color: Colors.textSecondary},
});
