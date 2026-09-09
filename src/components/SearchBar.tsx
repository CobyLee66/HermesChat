/**
 * SearchBar — 通用搜索条（聊天记录查找与会话列表过滤共用）。
 * 圆底输入框（ChatInputBar 同款配色）+ 可选匹配计数与 ↑/↓ 循环跳转 +
 * ✕ 关闭；导航区 props 不传即不渲染（会话列表过滤场景）。
 */

import React from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import {Colors} from './theme';

type Props = {
  value: string;
  onChangeText: (text: string) => void;
  onClose: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** 以下四项全传才显示「n/m + ↑/↓」导航区（聊天记录查找场景） */
  total?: number;
  /** 当前命中序号（0 基） */
  activeIndex?: number;
  onPrev?: () => void;
  onNext?: () => void;
};

export function SearchBar({
  value,
  onChangeText,
  onClose,
  placeholder = '搜索',
  autoFocus = true,
  total,
  activeIndex = 0,
  onPrev,
  onNext,
}: Props) {
  const hasNav =
    typeof total === 'number' && !!onPrev && !!onNext;
  const noHit = hasNav && total === 0;

  return (
    <View style={styles.bar}>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={Colors.textSecondary}
        autoFocus={autoFocus}
        autoCorrect={false}
        returnKeyType="search"
        onSubmitEditing={hasNav && !noHit ? onNext : undefined}
      />
      {hasNav ? (
        <Text style={[styles.count, noHit && styles.countEmpty]}>
          {noHit ? '无结果' : `${Math.min(activeIndex + 1, total ?? 0)}/${total}`}
        </Text>
      ) : null}
      {hasNav ? (
        <TouchableOpacity
          style={styles.navBtn}
          activeOpacity={0.6}
          disabled={noHit}
          onPress={onPrev}
          hitSlop={6}>
          <Text style={[styles.navText, noHit && styles.navTextDisabled]}>
            ↑
          </Text>
        </TouchableOpacity>
      ) : null}
      {hasNav ? (
        <TouchableOpacity
          style={styles.navBtn}
          activeOpacity={0.6}
          disabled={noHit}
          onPress={onNext}
          hitSlop={6}>
          <Text style={[styles.navText, noHit && styles.navTextDisabled]}>
            ↓
          </Text>
        </TouchableOpacity>
      ) : null}
      <TouchableOpacity
        style={styles.closeBtn}
        activeOpacity={0.6}
        onPress={onClose}
        hitSlop={6}>
        <Text style={styles.closeText}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
  },
  input: {
    flex: 1,
    backgroundColor: Colors.fill,
    borderRadius: 17,
    paddingHorizontal: 12,
    paddingVertical: 7,
    fontSize: 14,
    color: Colors.text,
  },
  count: {fontSize: 12, color: Colors.textSecondary, minWidth: 34, textAlign: 'right'},
  countEmpty: {minWidth: 46},
  navBtn: {width: 26, height: 26, alignItems: 'center', justifyContent: 'center'},
  navText: {fontSize: 17, color: Colors.text, lineHeight: 20},
  navTextDisabled: {color: Colors.border},
  closeBtn: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 2,
  },
  closeText: {fontSize: 15, color: Colors.textSecondary},
});
