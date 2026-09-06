/**
 * SessionColumn — 桌面会话列：列头（profile 名/切换器 + 新会话）+ 会话列表。
 * wide 三栏时 profile 切换在左侧竖条，列头只显示名字；medium 两栏时列头
 * 提供下拉切换器（含编辑资料/退出连接入口）。
 */

import React, {useCallback, useState} from 'react';
import {Modal, StyleSheet, Text, TouchableOpacity, View} from 'react-native';

import {Colors} from '../components/theme';
import {SessionListPanel, useProfileNickname} from '../panels/SessionListPanel';
import {createSessionFlow, type OpenedSession} from '../panels/sessionFlows';
import {useProfilesStore} from '../store/profiles';
import {useConnectionStore} from '../store/connection';
import {alertError, confirmDialog} from '../utils/alert';
import {openChat, useDesktopUiStore} from './desktopUiStore';

export function SessionColumn({
  profile,
  /** 列头是否带 profile 下拉切换器（medium 两栏布局） */
  showProfileSwitcher,
}: {
  profile: string;
  showProfileSwitcher?: boolean;
}) {
  const nicknameText = useProfileNickname(profile);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const onOpenSession = useCallback(
    (opened: OpenedSession) => {
      openChat({sessionId: opened.sessionId, profile, title: opened.title});
    },
    [profile],
  );

  const onNewSession = useCallback(async () => {
    if (creating) {
      return;
    }
    try {
      setCreating(true);
      const opened = await createSessionFlow(profile);
      openChat({sessionId: opened.sessionId, profile, title: opened.title});
    } catch (e) {
      alertError('新建会话失败', e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [creating, profile]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        {showProfileSwitcher ? (
          <TouchableOpacity
            style={styles.switcherBtn}
            activeOpacity={0.7}
            onPress={() => setSwitcherOpen(true)}>
            <Text style={styles.switcherText} numberOfLines={1}>
              {nicknameText} ▾
            </Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.titleWrap}>
            <Text style={styles.switcherText} numberOfLines={1}>
              {nicknameText}
            </Text>
          </View>
        )}
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={onNewSession}
          disabled={creating}>
          <Text style={[styles.newText, creating && styles.newTextDisabled]}>
            新会话
          </Text>
        </TouchableOpacity>
      </View>
      <SessionListPanel profile={profile} onOpenSession={onOpenSession} />

      {/* profile 下拉切换器（medium 布局） */}
      <Modal
        visible={switcherOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setSwitcherOpen(false)}>
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={() => setSwitcherOpen(false)}>
          <ProfileSwitcherMenu onDone={() => setSwitcherOpen(false)} />
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

/** profile 切换菜单：列表 + 编辑资料 + 退出连接。 */
function ProfileSwitcherMenu({onDone}: {onDone: () => void}) {
  const list = useProfilesStore(s => s.list);
  const selectedProfile = useDesktopUiStore(s => s.selectedProfile);
  const selectProfile = useDesktopUiStore(s => s.selectProfile);
  const setProfileEditOpen = useDesktopUiStore(s => s.setProfileEditOpen);

  return (
    <View style={styles.menu}>
      {list.map(p => (
        <ProfileMenuItem
          key={p.name}
          name={p.name}
          selected={p.name === selectedProfile}
          onPick={() => {
            selectProfile(p.name);
            onDone();
          }}
        />
      ))}
      <View style={styles.menuSep} />
      <TouchableOpacity
        style={styles.menuItem}
        onPress={() => {
          if (selectedProfile) {
            setProfileEditOpen(selectedProfile);
          }
          onDone();
        }}>
        <Text style={styles.menuText}>编辑当前资料…</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.menuItem}
        onPress={() => {
          onDone();
          void confirmDialog('退出连接', '确定断开与主机的连接吗？').then(ok => {
            if (ok) {
              useConnectionStore.getState().disconnect();
            }
          });
        }}>
        <Text style={styles.menuTextDanger}>退出连接</Text>
      </TouchableOpacity>
    </View>
  );
}

/** 单个 profile 菜单行（hook 独立成组件，避免循环内调用）。 */
function ProfileMenuItem({
  name,
  selected,
  onPick,
}: {
  name: string;
  selected: boolean;
  onPick: () => void;
}) {
  const nickname = useProfileNickname(name);
  return (
    <TouchableOpacity style={styles.menuItem} onPress={onPick}>
      <Text
        style={[styles.menuText, selected && styles.menuTextActive]}
        numberOfLines={1}>
        {selected ? '✓ ' : ''}
        {nickname}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: Colors.card},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 52,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
    paddingHorizontal: 14,
    gap: 12,
  },
  titleWrap: {flex: 1},
  switcherBtn: {flex: 1, paddingVertical: 8},
  switcherText: {fontSize: 16, fontWeight: '600', color: Colors.text},
  newText: {fontSize: 14, color: Colors.accent, fontWeight: '600'},
  newTextDisabled: {opacity: 0.4},
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'flex-start',
    alignItems: 'flex-start',
  },
  menu: {
    backgroundColor: Colors.card,
    borderRadius: 12,
    minWidth: 220,
    maxWidth: '70%',
    marginLeft: 12,
    marginTop: 60,
    paddingVertical: 4,
    overflow: 'hidden',
  },
  menuItem: {paddingVertical: 11, paddingHorizontal: 16},
  menuText: {fontSize: 14, color: Colors.text},
  menuTextActive: {fontWeight: '600'},
  menuTextDanger: {fontSize: 14, color: Colors.danger},
  menuSep: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.border,
    marginVertical: 4,
  },
});
