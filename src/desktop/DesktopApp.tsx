/**
 * DesktopApp — 桌面/web 响应式壳（连接 ready 后替换导航栈）。
 *
 * 布局按窗口宽度自适应（见 ui/breakpoints.ts）：
 * - wide ≥1280：Profile 竖条 + 会话列 + 聊天区
 * - medium 900–1279：会话列 + 聊天区
 * - narrow <900：单列（Profile 列表 → 会话列 → 聊天，同手机流程）
 *
 * 会话列头统一带「‹ 返回」按钮，任何断点都可回到 Profile 选择首屏。
 *
 * 业务面板与手机屏幕同源（panels/）；本壳只负责列布局与选中态。
 */

import React, {useEffect} from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  FlatList,
} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';

import {Avatar} from '../components/Avatar';
import {Colors} from '../components/theme';
import {useProfileNickname} from '../panels/SessionListPanel';
import {ProfileEditScreen} from '../screens/ProfileEditScreen';
import {useConnectionStore} from '../store/connection';
import {useProfilesStore} from '../store/profiles';
import {ConfirmDialogHost} from '../ui/ConfirmDialogHost';
import {useBreakpoint} from '../ui/breakpoints';
import {alertError} from '../utils/alert';
import {ChatPane} from './ChatPane';
import {openChat, useDesktopUiStore} from './desktopUiStore';
import {ProfileRail} from './ProfileRail';
import {SessionColumn} from './SessionColumn';
import {createSessionFlow} from '../panels/sessionFlows';
import {useCompleteNotifications} from './useCompleteNotifications';

const EditStack = createNativeStackNavigator<{ProfileEdit: {profile: string}}>();

/** 桌面壳入口：响应式布局 + 全局自绘弹层 + 失焦通知。 */
export function DesktopApp() {
  useCompleteNotifications(true);
  return (
    <>
      <DesktopAppShell />
      <ConfirmDialogHost />
    </>
  );
}

function DesktopAppShell() {
  const breakpoint = useBreakpoint();
  const connState = useConnectionStore(s => s.state);
  const selectedProfile = useDesktopUiStore(s => s.selectedProfile);
  const chat = useDesktopUiStore(s => s.chat);
  const narrowPane = useDesktopUiStore(s => s.narrowPane);
  const profileEditOpen = useDesktopUiStore(s => s.profileEditOpen);
  const reset = useDesktopUiStore(s => s.reset);

  const refreshProfiles = useProfilesStore(s => s.refresh);

  useEffect(() => {
    // 壳挂载即清残留选中态并拉取 profile 列表（原 ProfileListScreen 行为）
    reset();
    refreshProfiles();
  }, [reset, refreshProfiles]);

  // Ctrl+N / Cmd+N 新会话
  useEffect(() => {
    if (!selectedProfile) {
      return;
    }
    const onKey = (ev: {
      key?: string;
      ctrlKey?: boolean;
      metaKey?: boolean;
      preventDefault?: () => void;
    }) => {
      if (
        !(ev.ctrlKey || ev.metaKey) ||
        (ev.key !== 'n' && ev.key !== 'N')
      ) {
        return;
      }
      ev.preventDefault?.();
      void createSessionFlow(selectedProfile)
        .then(opened =>
          openChat({
            sessionId: opened.sessionId,
            profile: selectedProfile,
            title: opened.title,
          }),
        )
        .catch(e =>
          alertError('新建会话失败', e instanceof Error ? e.message : String(e)),
        );
    };
    const win = (globalThis as {
      window?: {addEventListener?: (t: string, l: unknown) => void; removeEventListener?: (t: string, l: unknown) => void};
    }).window;
    win?.addEventListener?.('keydown', onKey);
    return () => {
      win?.removeEventListener?.('keydown', onKey);
    };
  }, [selectedProfile]);

  const reconnecting = connState === 'reconnecting';

  if (!selectedProfile) {
    return (
      <View style={styles.root}>
        {reconnecting ? <ReconnectingBanner /> : null}
        <ProfileListPane />
        {profileEditOpen ? <ProfileEditModal profile={profileEditOpen} /> : null}
      </View>
    );
  }

  if (breakpoint === 'narrow') {
    const showChat = narrowPane === 'chat' && chat != null;
    return (
      <View style={styles.root}>
        {reconnecting ? <ReconnectingBanner /> : null}
        {showChat && chat ? (
          <ChatPane chat={chat} narrow />
        ) : (
          <SessionColumn profile={selectedProfile} />
        )}
        {profileEditOpen ? <ProfileEditModal profile={profileEditOpen} /> : null}
      </View>
    );
  }

  if (breakpoint === 'medium') {
    return (
      <View style={styles.root}>
        {reconnecting ? <ReconnectingBanner /> : null}
        <View style={styles.sessionCol}>
          <SessionColumn profile={selectedProfile} />
        </View>
        <View style={styles.chatCol}>{chat ? <ChatPane chat={chat} /> : <EmptyChatPane />}</View>
        {profileEditOpen ? <ProfileEditModal profile={profileEditOpen} /> : null}
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {reconnecting ? <ReconnectingBanner /> : null}
      <ProfileRail />
      <View style={styles.sessionCol}>
        <SessionColumn profile={selectedProfile} />
      </View>
      <View style={styles.chatCol}>
        {chat ? <ChatPane chat={chat} /> : <EmptyChatPane />}
      </View>
      {profileEditOpen ? <ProfileEditModal profile={profileEditOpen} /> : null}
    </View>
  );
}

function ReconnectingBanner() {
  return (
    <View style={styles.banner}>
      <Text style={styles.bannerText}>连接已断开，正在重连…</Text>
    </View>
  );
}

/** 未选会话时的聊天区空态。 */
function EmptyChatPane() {
  return (
    <View style={styles.emptyWrap}>
      <Text style={styles.emptyText}>从会话列表选择一个会话</Text>
      <Text style={styles.emptyHint}>或点左上角「新会话」开始新对话</Text>
    </View>
  );
}

/** Profile 全宽列表（未选 profile 时的首屏，所有断点共用）。 */
function ProfileListPane() {
  const list = useProfilesStore(s => s.list);
  const selectProfile = useDesktopUiStore(s => s.selectProfile);
  const setProfileEditOpen = useDesktopUiStore(s => s.setProfileEditOpen);

  return (
    <View style={styles.profilePane}>
      <View style={styles.profilePaneHeader}>
        <Text style={styles.profilePaneTitle}>选择 Profile</Text>
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => {
            useConnectionStore.getState().disconnect();
          }}>
          <Text style={styles.exitText}>退出连接</Text>
        </TouchableOpacity>
      </View>
      <FlatList
        data={list}
        keyExtractor={p => p.name}
        contentContainerStyle={styles.profileListContent}
        renderItem={({item}) => (
          <ProfilePaneRow
            name={item.name}
            preview={
              item.last_session?.preview ||
              item.description ||
              `${item.skill_count ?? 0} 个技能`
            }
            onOpen={() => selectProfile(item.name)}
            onEdit={() => setProfileEditOpen(item.name)}
          />
        )}
      />
    </View>
  );
}

/** 单行 profile（hook 独立成组件，避免 render 循环内调用）。 */
function ProfilePaneRow({
  name,
  preview,
  onOpen,
  onEdit,
}: {
  name: string;
  preview: string;
  onOpen: () => void;
  onEdit: () => void;
}) {
  const nickname = useProfileNickname(name);
  const avatarUri = useProfilesStore(s => s.avatars[name]);
  return (
    <TouchableOpacity
      style={styles.profileRow}
      activeOpacity={0.7}
      onPress={onOpen}
      accessibilityLabel={`打开 profile ${nickname}`}>
      <Avatar name={nickname} uri={avatarUri} size={46} />
      <View style={styles.profileRowBody}>
        <Text style={styles.profileName} numberOfLines={1}>
          {nickname}
        </Text>
        <Text style={styles.profileDesc} numberOfLines={1}>
          {preview}
        </Text>
      </View>
      <TouchableOpacity style={styles.editBtn} hitSlop={8} onPress={onEdit}>
        <Text style={styles.editText}>编辑</Text>
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

/**
 * Profile 编辑弹层：复用 ProfileEditScreen（只读 route 参数、goBack 无依赖），
 * 用嵌套 NavigationContainer 提供 useRoute 上下文。
 */
function ProfileEditModal({profile}: {profile: string}) {
  const setProfileEditOpen = useDesktopUiStore(s => s.setProfileEditOpen);
  const close = () => setProfileEditOpen(null);
  return (
    <Modal visible animationType="slide" onRequestClose={close}>
      {/* 本容器与外层导航栈互斥挂载（App 层二选一），是当前唯一的容器 */}
      <NavigationContainer>
        <EditStack.Navigator>
          <EditStack.Screen
            name="ProfileEdit"
            component={ProfileEditScreen}
            initialParams={{profile}}
            options={{
              title: '编辑资料',
              headerLeft: () => (
                <TouchableOpacity activeOpacity={0.7} onPress={close} hitSlop={8}>
                  <Text style={styles.backText}>‹ 返回</Text>
                </TouchableOpacity>
              ),
            }}
          />
        </EditStack.Navigator>
      </NavigationContainer>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: Colors.bg, flexDirection: 'row', flexWrap: 'nowrap'},
  sessionCol: {
    width: 300,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: Colors.border,
  },
  chatCol: {flex: 1},
  backText: {fontSize: 15, color: Colors.accent},
  banner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 5,
    backgroundColor: '#FFF7E8',
    paddingVertical: 6,
    alignItems: 'center',
  },
  bannerText: {fontSize: 12, color: '#FF7D00'},
  emptyWrap: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  emptyText: {fontSize: 15, color: Colors.textSecondary},
  emptyHint: {fontSize: 13, color: Colors.textSecondary, marginTop: 6},
  profilePane: {flex: 1, backgroundColor: Colors.card},
  profilePaneHeader: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  profilePaneTitle: {fontSize: 17, fontWeight: '600', color: Colors.text},
  exitText: {fontSize: 14, color: Colors.danger},
  profileListContent: {maxWidth: 720, width: '100%', alignSelf: 'center'},
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  profileRowBody: {flex: 1, marginLeft: 12},
  profileName: {fontSize: 16, fontWeight: '500', color: Colors.text},
  profileDesc: {fontSize: 13, color: Colors.textSecondary, marginTop: 3},
  editBtn: {
    marginLeft: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  editText: {fontSize: 13, color: Colors.textSecondary},
});
