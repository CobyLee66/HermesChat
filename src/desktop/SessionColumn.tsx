/**
 * SessionColumn — 桌面会话列：列头（返回按钮 + profile 名 + 新会话）+ 会话列表。
 * 三种断点布局统一：列头「‹ 返回」回 Profile 选择首屏；wide 三栏时左侧竖条
 * 仍保留做快速切换。web 下会话行支持右键菜单（复制标题/删除）。
 */

import React, {useCallback, useState} from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';

import {Colors} from '../components/theme';
import {useT} from '../i18n';
import {
  SessionListPanel,
  useProfileNickname,
  type RowContextMenuPos,
} from '../panels/SessionListPanel';
import {
  createSessionFlow,
  deleteSessionFlow,
  type OpenedSession,
} from '../panels/sessionFlows';
import type {SessionListRow} from '../rpc/types';
import {alertError} from '../utils/alert';
import {openChat, useDesktopUiStore} from './desktopUiStore';

/** 右键菜单卡估算尺寸（定位 clamp 防溢出窗口用） */
const MENU_WIDTH = 200;
const MENU_HEIGHT = 100;

export function SessionColumn({profile}: {profile: string}) {
  const t = useT();
  const nicknameText = useProfileNickname(profile);
  const selectProfile = useDesktopUiStore(s => s.selectProfile);
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<{
    row: SessionListRow;
    pos: RowContextMenuPos;
  } | null>(null);
  const {width: winW, height: winH} = useWindowDimensions();

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
      alertError(t('desktop.newSessionFailed'), e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [creating, profile, t]);

  const onRowContextMenu = useCallback(
    (row: SessionListRow, pos: RowContextMenuPos) => {
      setMenu({row, pos});
    },
    [],
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  const onCopyTitle = useCallback(() => {
    if (menu) {
      // RNW 无 Clipboard 模块，走浏览器剪贴板（无 DOM lib：结构类型断言）
      const clipboard = (globalThis as {
        navigator?: {clipboard?: {writeText?: (t: string) => Promise<void>}};
      }).navigator?.clipboard;
      void clipboard
        ?.writeText?.(menu.row.title || t('session.untitled'))
        ?.catch(() => {});
    }
    closeMenu();
  }, [menu, closeMenu, t]);

  const onDelete = useCallback(() => {
    if (menu) {
      void deleteSessionFlow(profile, menu.row.id, menu.row.title);
    }
    closeMenu();
  }, [menu, profile, closeMenu]);

  // 菜单贴光标弹出；靠右/靠下时向内收避免溢出窗口
  const menuLeft = menu ? Math.min(menu.pos.x, winW - MENU_WIDTH - 8) : 0;
  const menuTop = menu ? Math.min(menu.pos.y, winH - MENU_HEIGHT - 8) : 0;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => selectProfile(null)}
          hitSlop={8}>
          <Text style={styles.backText}>{t('common.back')}</Text>
        </TouchableOpacity>
        <View style={styles.titleWrap}>
          <Text style={styles.titleText} numberOfLines={1}>
            {nicknameText}
          </Text>
        </View>
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={onNewSession}
          disabled={creating}>
          <Text style={[styles.newText, creating && styles.newTextDisabled]}>
            {t('session.newTitle')}
          </Text>
        </TouchableOpacity>
      </View>
      <SessionListPanel
        profile={profile}
        onOpenSession={onOpenSession}
        onRowContextMenu={onRowContextMenu}
      />

      {/* 会话行右键菜单（web/桌面；backdrop 点击或 Esc 关闭） */}
      <Modal
        visible={menu != null}
        transparent
        animationType="fade"
        onRequestClose={closeMenu}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={closeMenu}>
          <View style={[styles.menu, {left: menuLeft, top: menuTop}]}>
            <TouchableOpacity style={styles.menuItem} onPress={onCopyTitle}>
              <Text style={styles.menuText}>{t('desktop.copyTitle')}</Text>
            </TouchableOpacity>
            <View style={styles.menuSep} />
            <TouchableOpacity style={styles.menuItem} onPress={onDelete}>
              <Text style={styles.menuTextDanger}>{t('session.deleteTitle')}</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
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
  backText: {fontSize: 15, color: Colors.accent},
  titleWrap: {flex: 1},
  titleText: {fontSize: 16, fontWeight: '600', color: Colors.text},
  newText: {fontSize: 14, color: Colors.accent, fontWeight: '600'},
  newTextDisabled: {opacity: 0.4},
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.15)',
  },
  menu: {
    position: 'absolute',
    backgroundColor: Colors.card,
    borderRadius: 12,
    width: MENU_WIDTH,
    paddingVertical: 4,
    overflow: 'hidden',
    // 阴影让菜单与背景分层（web/原生通吃写法）
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: {width: 0, height: 4},
    elevation: 8,
  },
  menuItem: {paddingVertical: 11, paddingHorizontal: 16},
  menuText: {fontSize: 14, color: Colors.text},
  menuTextDanger: {fontSize: 14, color: Colors.danger},
  menuSep: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.border,
    marginVertical: 4,
  },
});
