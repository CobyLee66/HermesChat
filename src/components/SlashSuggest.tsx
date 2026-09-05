import React from 'react';
import {ScrollView, StyleSheet, Text, TouchableOpacity, View} from 'react-native';

import {Colors} from './theme';
import type {SlashCompletionItem} from '../rpc/slash';

interface Props {
  items: SlashCompletionItem[];
  /** 当前键盘/点选选中的行下标。 */
  selected: number;
  /** 点选某行（应用该补全项）。 */
  onPick: (index: number) => void;
}

/**
 * 斜杠命令补全浮层（对齐 web dashboard SlashPopover 的两列布局：
 * display 等宽命令名 + meta 右对齐说明/参数用法）。由 ChatScreen 挂在
 * 消息列表容器内、bottom:8 贴住输入框上沿，盖住最新消息，不占布局。
 */
export function SlashSuggest({items, selected, onPick}: Props) {
  return (
    <View style={styles.sheet}>
      <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
        {items.map((it, i) => {
          const active = i === selected;
          return (
            <TouchableOpacity
              key={`${it.text}-${i}`}
              style={[styles.row, active ? styles.rowActive : null]}
              activeOpacity={0.7}
              onPress={() => onPick(i)}
              accessibilityRole="button"
              accessibilityLabel={`补全 ${it.display}`}>
              <Text
                style={[styles.display, active ? styles.displayActive : null]}
                numberOfLines={1}>
                {it.display}
              </Text>
              {it.meta ? (
                <Text style={styles.meta} numberOfLines={1}>
                  {it.meta}
                </Text>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 8,
    maxHeight: 264, // 对齐 web max-h-64
    borderRadius: 12,
    backgroundColor: Colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    // 阴影口径同「回到底部」浮钮
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: {width: 0, height: 2},
    elevation: 3,
    overflow: 'hidden',
  },
  list: {maxHeight: 264},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  rowActive: {
    backgroundColor: '#F0F9FE', // accent 8% 左右的浅底
  },
  display: {
    fontFamily: 'monospace' as never,
    fontSize: 13,
    color: Colors.text,
    flexShrink: 0,
  },
  displayActive: {color: Colors.accentDark, fontWeight: '600'},
  meta: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginLeft: 'auto',
    flexShrink: 1,
  },
});
