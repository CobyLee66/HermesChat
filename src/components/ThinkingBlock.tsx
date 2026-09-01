import React, {useEffect, useRef, useState} from 'react';
import {Animated, StyleSheet, Text, TouchableOpacity, View} from 'react-native';

import {Colors} from './theme';

interface Props {
  text: string;
  /** thinking=思考过程 reasoning=推理过程 */
  variant: 'thinking' | 'reasoning';
}

/** 思考/推理块：默认折叠，灰字，点击展开。 */
export function ThinkingBlock({text, variant}: Props) {
  const [expanded, setExpanded] = useState(false);
  const label = variant === 'thinking' ? '思考过程' : '推理过程';
  const preview = text.trim().split('\n')[0] ?? '';
  return (
    <View style={styles.wrap}>
      <TouchableOpacity onPress={() => setExpanded(v => !v)} activeOpacity={0.7}>
        <Text style={styles.header}>
          {expanded ? '▾' : '▸'} {label}
          {expanded ? '' : `  ${preview.slice(0, 40)}${preview.length > 40 ? '…' : ''}`}
        </Text>
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
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  header: {
    fontSize: 12,
    color: Colors.textSecondary,
  },
  body: {
    marginTop: 4,
    fontSize: 13,
    lineHeight: 19,
    color: Colors.textSecondary,
  },
  cursor: {
    fontSize: 16,
    color: Colors.accent,
  },
});
