import React, {useState} from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import {MarkdownText} from './MarkdownText';
import {Colors} from './theme';

interface Props {
  text: string;
  isUser: boolean;
}

/**
 * 聊天气泡：用户右（浅蓝）、助手左（白）。无头像占位，尽量撑满宽度。
 * 文本选择/复制策略：
 * - 用户消息：纯文本 Text(selectable)，系统原生长按选择；
 * - 助手消息：markdown 渲染在 RN 里无法整条连贯选择（段落/表格是独立控件），
 *   改为长按 0.5s 直接弹出文本选择窗口，内容为**原始 markdown 源码**（保留
 *   格式符号），用系统选择菜单操作。承载控件用只读多行 TextInput：内容超出
 *   高度时在框内滚动，选择拖拽到边缘可自动滚动，不像外层 ScrollView 会卡住。
 * QQ 风格角标箭头：纯 View border 三角形，压在与气泡相接的上角
 * （assistant 左上指向左，user 右上指向右），颜色与气泡一致。
 */
export function Bubble({text, isUser}: Props) {
  const [selectVisible, setSelectVisible] = useState(false);

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
        activeOpacity={0.9}
        delayLongPress={500}
        onLongPress={() => setSelectVisible(true)}>
        <View style={[styles.bubble, styles.assistant]}>
          <View style={[styles.arrow, styles.arrowAssistant]} />
          <MarkdownText text={text} />
        </View>
      </TouchableOpacity>

      {/* 文本选择窗口：原始 markdown 源码，系统拖选 + 复制；框内自动滚动 */}
      <Modal
        visible={selectVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectVisible(false)}>
        <View style={styles.backdrop}>
          <View style={styles.selectCard}>
            <Text style={styles.selectHint}>
              长按文本选择，拖到上下边缘自动滚动，再通过系统菜单复制
            </Text>
            <TextInput
              style={styles.selectInput}
              value={text}
              multiline
              readOnly
              textAlignVertical="top"
              autoCorrect={false}
              spellCheck={false}
            />
            <TouchableOpacity
              style={styles.selectClose}
              activeOpacity={0.8}
              onPress={() => setSelectVisible(false)}>
              <Text style={styles.selectCloseText}>关闭</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
    // 横向占满可用宽度（外层 12px 边距保留），不因对话者在一侧留白
    maxWidth: '100%',
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
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  selectCard: {
    backgroundColor: Colors.card,
    borderRadius: 12,
    padding: 16,
    width: '90%',
    maxHeight: '75%',
  },
  selectHint: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginBottom: 10,
  },
  /** 只读多行输入框：内容超高时在框内滚动，选择拖拽越过边缘能自动滚动 */
  selectInput: {
    minHeight: 90,
    maxHeight: 400,
    fontSize: 15,
    lineHeight: 22,
    color: Colors.text,
    backgroundColor: Colors.bg,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  selectClose: {
    alignSelf: 'center',
    marginTop: 12,
    borderRadius: 17,
    paddingHorizontal: 24,
    paddingVertical: 8,
    backgroundColor: Colors.accent,
  },
  selectCloseText: {fontSize: 14, color: '#FFFFFF', fontWeight: '500'},
});
