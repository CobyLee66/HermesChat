import React, {useState} from 'react';
import {
  Clipboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import {MarkdownText} from './MarkdownText';
import {Colors} from './theme';
import {markdownToPlain} from '../utils/markdownPlain';

interface Props {
  text: string;
  isUser: boolean;
}

/**
 * 聊天气泡：用户右（浅蓝）、助手左（白）。无头像占位，尽量撑满宽度。
 * 文本复制策略：
 * - 用户消息：纯文本 Text(selectable)，直接用系统原生长按选择；
 * - 助手消息：markdown 渲染无法整条连贯可选（段落/表格是独立控件），
 *   改为长按 0.5s 弹「全选 / 部分选择」菜单——全选把整条转成纯文本进剪贴板；
 *   部分选择打开可选文本弹层，用系统拖选手柄逐句/逐段选择后复制。
 * QQ 风格角标箭头：纯 View border 三角形，压在与气泡相接的上角
 * （assistant 左上指向左，user 右上指向右），颜色与气泡一致。
 */
export function Bubble({text, isUser}: Props) {
  const [menuVisible, setMenuVisible] = useState(false);
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

  // 助手消息：复制内容为 markdown 去语法后的纯文本（表格转制表符分隔）
  const plain = markdownToPlain(text);

  return (
    <View style={[styles.row, styles.rowLeft]}>
      <Pressable
        delayLongPress={500}
        onLongPress={() => setMenuVisible(true)}
        style={styles.pressable}>
        <View style={[styles.bubble, styles.assistant]}>
          <View style={[styles.arrow, styles.arrowAssistant]} />
          <MarkdownText text={text} />
        </View>
      </Pressable>

      {/* 长按菜单：全选 / 部分选择 */}
      <Modal
        visible={menuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuVisible(false)}>
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={() => setMenuVisible(false)}>
          <View style={styles.menu}>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setMenuVisible(false);
                Clipboard.setString(plain || text);
              }}>
              <Text style={styles.menuText}>全选</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setMenuVisible(false);
                setSelectVisible(true);
              }}>
              <Text style={styles.menuText}>部分选择</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* 部分选择：整条纯文本可选弹层（系统手柄拖选 + 系统复制菜单） */}
      <Modal
        visible={selectVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectVisible(false)}>
        <View style={styles.backdrop}>
          <View style={styles.selectCard}>
            <Text style={styles.selectHint}>
              长按下方文本拖动选择，通过系统菜单复制
            </Text>
            <ScrollView style={styles.selectScroll}>
              <Text style={styles.selectText} selectable>
                {plain || text}
              </Text>
            </ScrollView>
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
  /** Pressable 整块包住气泡，避免内容区吃掉长按手势 */
  pressable: {maxWidth: '100%'},
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
  menu: {
    backgroundColor: Colors.card,
    borderRadius: 12,
    minWidth: 180,
    overflow: 'hidden',
  },
  menuItem: {paddingVertical: 13, paddingHorizontal: 20},
  menuText: {fontSize: 15, color: Colors.text},
  selectCard: {
    backgroundColor: Colors.card,
    borderRadius: 12,
    padding: 16,
    width: '88%',
    maxHeight: '70%',
  },
  selectHint: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginBottom: 10,
  },
  selectScroll: {flexGrow: 0},
  selectText: {fontSize: 15, lineHeight: 22, color: Colors.text},
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
