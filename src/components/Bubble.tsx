import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

import {Colors} from './theme';

interface Props {
  text: string;
  isUser: boolean;
}

/** 聊天气泡：用户右（浅蓝），助手左（白）。 */
export function Bubble({text, isUser}: Props) {
  return (
    <View style={[styles.row, isUser ? styles.rowRight : styles.rowLeft]}>
      <View style={[styles.bubble, isUser ? styles.user : styles.assistant]}>
        <Text style={styles.text} selectable>
          {text}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    marginVertical: 3,
  },
  rowRight: {justifyContent: 'flex-end'},
  rowLeft: {justifyContent: 'flex-start'},
  bubble: {
    maxWidth: '82%',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  user: {
    backgroundColor: Colors.userBubble,
    borderTopRightRadius: 4,
  },
  assistant: {
    backgroundColor: Colors.assistantBubble,
    borderTopLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  text: {
    fontSize: 16,
    lineHeight: 23,
    color: Colors.text,
  },
});
