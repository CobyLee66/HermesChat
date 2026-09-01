import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

import type {FileRef} from '../rpc/types';
import {Colors} from './theme';

interface Props {
  file: FileRef;
  isUser?: boolean;
}

/** 文件引用卡片（@file: 指令）：只显示文件名，不支持下载预览。 */
export function FileRefCard({file, isUser}: Props) {
  return (
    <View style={[styles.card, isUser ? styles.cardUser : null]}>
      <Text style={styles.icon}>📎</Text>
      <Text style={styles.name} numberOfLines={1}>
        {file.name}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    maxWidth: '82%',
    marginTop: 4,
    backgroundColor: Colors.card,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  cardUser: {alignSelf: 'flex-end', backgroundColor: Colors.userBubble},
  icon: {fontSize: 13, marginRight: 6},
  name: {fontSize: 13, color: Colors.text, flexShrink: 1},
});
