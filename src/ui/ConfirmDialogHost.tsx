/**
 * ConfirmDialogHost — 桌面/web 自绘确认/提示弹层（挂 DesktopApp 根部）。
 * 替代 RNW 下无 UI 的 Alert.alert 与观感差的 window.confirm。
 */

import React from 'react';
import {Modal, StyleSheet, Text, TouchableOpacity, View} from 'react-native';

import {Colors} from '../components/theme';
import {useDialogStore} from './dialogStore';

export function ConfirmDialogHost() {
  const current = useDialogStore(s => s.current);
  const settle = useDialogStore(s => s.settle);
  if (!current) {
    return null;
  }
  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => settle(false)}>
      <TouchableOpacity
        style={styles.backdrop}
        activeOpacity={1}
        onPress={() => settle(current.kind === 'alert')}>
        <View style={styles.card}>
          <Text style={styles.title}>{current.title}</Text>
          <Text style={styles.message}>{current.message}</Text>
          <View style={styles.btnRow}>
            {current.kind === 'confirm' ? (
              <TouchableOpacity
                style={[styles.btn, styles.btnGhost]}
                activeOpacity={0.8}
                onPress={() => settle(false)}>
                <Text style={styles.btnGhostText}>取消</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary]}
              activeOpacity={0.8}
              onPress={() => settle(true)}>
              <Text style={styles.btnPrimaryText}>
                {current.kind === 'alert' ? '知道了' : '确定'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    backgroundColor: Colors.card,
    borderRadius: 12,
    padding: 20,
    width: 360,
    maxWidth: '86%',
  },
  title: {fontSize: 16, fontWeight: '600', color: Colors.text},
  message: {fontSize: 14, color: Colors.textSecondary, marginTop: 8, lineHeight: 20},
  btnRow: {flexDirection: 'row', justifyContent: 'flex-end', marginTop: 18, gap: 10},
  btn: {
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 18,
  },
  btnGhost: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  btnGhostText: {fontSize: 14, color: Colors.textSecondary},
  btnPrimary: {backgroundColor: Colors.accent},
  btnPrimaryText: {fontSize: 14, color: '#FFFFFF', fontWeight: '600'},
});
