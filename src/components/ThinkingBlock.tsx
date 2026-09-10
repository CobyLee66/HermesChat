import React, {useEffect, useRef, useState} from 'react';
import {Animated, StyleSheet, Text, TouchableOpacity, View} from 'react-native';

import {thinkingHead, thinkingTail} from '../utils/thinkingPreview';
import {Colors} from './theme';

interface Props {
  text: string;
  /** thinking=思考过程 reasoning=推理过程 */
  variant: 'thinking' | 'reasoning';
  /** 该块正处流式接收中（消息在流式且本块是末位块）：第二行实时刷新最新输出 */
  live?: boolean;
}

/** 思考/推理块：结构对齐工具调用卡——第一行粗体标签，第二行内容预览
 *（流式中显示尾部两行实时刷新，结束后缩略为开头一行），点击展开全文。 */
export function ThinkingBlock({text, variant, live}: Props) {
  const [expanded, setExpanded] = useState(false);
  const label = variant === 'thinking' ? '思考过程' : '推理过程';
  return (
    <View style={styles.wrap}>
      <TouchableOpacity
        onPress={() => setExpanded(v => !v)}
        activeOpacity={0.7}
        style={styles.headerRow}>
        <View style={styles.headerTextWrap}>
          <Text style={styles.label}>{label}</Text>
          {!expanded ? (
            live ? (
              <Text style={styles.liveBody} numberOfLines={2}>
                {thinkingTail(text)}
              </Text>
            ) : (
              <Text style={styles.preview} numberOfLines={1}>
                {thinkingHead(text)}
              </Text>
            )
          ) : null}
        </View>
        <Text style={styles.chevron}>{expanded ? '▾' : '▸'}</Text>
      </TouchableOpacity>
      {expanded ? <Text style={styles.body}>{text}</Text> : null}
    </View>
  );
}

/** 流式光标：闪烁的 ▍。 */
export function StreamCursor() {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {toValue: 0.15, duration: 450, useNativeDriver: true}),
        Animated.timing(opacity, {toValue: 1, duration: 450, useNativeDriver: true}),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return (
    <Animated.Text style={[styles.cursor, {opacity}]}>▍</Animated.Text>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 4,
    backgroundColor: Colors.thinkingBg,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  headerTextWrap: {flex: 1},
  label: {fontSize: 13, fontWeight: '600', color: Colors.text},
  preview: {fontSize: 12, color: Colors.textSecondary, marginTop: 1},
  liveBody: {fontSize: 12, lineHeight: 17, color: Colors.textSecondary, marginTop: 1},
  chevron: {fontSize: 12, color: Colors.textSecondary, marginLeft: 6},
  body: {
    marginTop: 2,
    paddingHorizontal: 10,
    paddingBottom: 8,
    fontSize: 13,
    lineHeight: 19,
    color: Colors.textSecondary,
  },
  cursor: {
    fontSize: 16,
    color: Colors.accent,
  },
});
