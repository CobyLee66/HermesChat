import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

import {Colors} from './theme';

interface Props {
  text: string;
  isUser: boolean;
}

/**
 * 聊天气泡：用户右（浅蓝）、助手左（白）。无头像占位，尽量撑满宽度。
 * QQ 风格角标箭头：纯 View border 三角形，压在与气泡相接的上角
 * （assistant 左上指向左，user 右上指向右），颜色与气泡一致。
 */
export function Bubble({text, isUser}: Props) {
  return (
    <View style={[styles.row, isUser ? styles.rowRight : styles.rowLeft]}>
      <View style={[styles.bubble, isUser ? styles.user : styles.assistant]}>
        <View
          style={[
            styles.arrow,
            isUser ? styles.arrowUser : styles.arrowAssistant,
          ]}
        />
        <Text style={styles.text} selectable>
          {text}
        </Text>
      </View>
    </View>
  );
}

/** 箭头半高（border 三角形纵向各 5，全长 10）；探出气泡 8px。 */
const ARROW_HALF = 5;
const ARROW_LEN = 8;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    marginVertical: 3,
  },
  rowRight: {justifyContent: 'flex-end'},
  rowLeft: {justifyContent: 'flex-start'},
  bubble: {
    maxWidth: '92%',
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
  /** border 三角形：上下透明 border + 一条着色 border，width/height 为 0。 */
  arrow: {
    position: 'absolute',
    top: 6,
    width: 0,
    height: 0,
    borderTopWidth: ARROW_HALF,
    borderBottomWidth: ARROW_HALF,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
  },
  /** 助手：左上角，尖端朝左，底色盖住气泡描边使二者相接。 */
  arrowAssistant: {
    left: -ARROW_LEN + 1,
    borderRightWidth: ARROW_LEN,
    borderRightColor: Colors.assistantBubble,
  },
  /** 用户：右上角，尖端朝右。 */
  arrowUser: {
    right: -ARROW_LEN + 1,
    borderLeftWidth: ARROW_LEN,
    borderLeftColor: Colors.userBubble,
  },
  text: {
    fontSize: 16,
    lineHeight: 23,
    color: Colors.text,
  },
});
