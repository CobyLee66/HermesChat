import React from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';

import {MarkdownText} from './MarkdownText';
import {Colors} from './theme';

interface Props {
  text: string;
  isUser: boolean;
  /** 助手消息长按时回调（ChatScreen 负责弹文本选择层，Modal 里可编辑
   *  EditText 的系统选择菜单会被立刻关掉，普通窗口树里才稳定） */
  onSelectText?: (text: string) => void;
}

/**
 * 聊天气泡：用户右（浅蓝）、助手左（白）。无头像占位，尽量撑满宽度。
 * 文本选择/复制策略：
 * - 用户消息：纯文本 Text(selectable)，系统原生长按选择；
 * - 助手消息：markdown 渲染在 RN 里无法整条连贯选择，长按 0.5s 上报
 *   onSelectText，由屏幕层弹出原始文本选择窗口（含 markdown 格式符号）。
 * QQ 风格角标箭头：纯 View border 三角形，压在与气泡相接的上角
 * （assistant 左上指向左，user 右上指向右），颜色与气泡一致。
 */
export function Bubble({text, isUser, onSelectText}: Props) {
  if (isUser) {
    return (
      <View style={[styles.row, styles.rowRight]}>
        <View style={[styles.bubble, styles.user]}>
          <View style={[styles.arrow, styles.arrowUser]} />
          <Text style={styles.text} selectable>
            {text}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.row, styles.rowLeft]}>
      <TouchableOpacity
        style={styles.touchable}
        activeOpacity={0.9}
        delayLongPress={500}
        onLongPress={() => onSelectText?.(text)}>
        <View style={[styles.bubble, styles.assistant]}>
          <View style={[styles.arrow, styles.arrowAssistant]} />
          <MarkdownText text={text} />
        </View>
      </TouchableOpacity>
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
  // web 端 flex 子项按未换行的整段文字取 max-content 宽且 RN 默认 flexShrink 0,
  // 内容超宽会把气泡撑出屏幕;允许收缩后回到容器宽(原生 Yoga 本就按可用宽度
  // 测量文本,无溢出压力时收缩不触发,行为不变)
  touchable: {flexShrink: 1},
  bubble: {
    // 横向占满可用宽度（外层 12px 边距保留），不因对话者在一侧留白
    maxWidth: '100%',
    flexShrink: 1,
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
