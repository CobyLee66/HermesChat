/**
 * SessionListPanel — 会话列表面板（过滤条 + 列表 + 行 + 空态）。
 * 手机 SessionListScreen 与桌面会话列共用；导航差异通过 onOpenSession/
 * onNewSession 回调注入。zustand 选择器返回稳定引用（EMPTY 常量约定）。
 */

import React, {useCallback, useMemo, useState} from 'react';
import {FlatList, StyleSheet, Text, TouchableOpacity, View} from 'react-native';

import {Avatar} from '../components/Avatar';
import {Colors} from '../components/theme';
import {useProfilesStore} from '../store/profiles';
import {useSessionsStore} from '../store/sessions';
import {alertError, confirmDialog} from '../utils/alert';
import {
  automationSourceLabel,
  isAutomationSource,
  sourceBelongsToCategory,
  type SessionFilterCategory,
} from '../utils/sessionSources';
import type {SessionListRow} from '../rpc/types';
import {openSessionFlow, type OpenedSession} from './sessionFlows';

const EMPTY_SESSIONS: SessionListRow[] = [];

const FILTER_OPTIONS: {key: SessionFilterCategory; label: string}[] = [
  {key: 'chats', label: '聊天'},
  {key: 'automation', label: '自动化'},
  {key: 'all', label: '全部'},
];

function formatTime(ts: number): string {
  if (!ts) {
    return '';
  }
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** profile 昵称（ui_meta.nickname > description > name），列表行头像/标题用。 */
export function useProfileNickname(profile: string): string {
  const profileInfo = useProfilesStore(s => s.list.find(p => p.name === profile));
  return (
    (profileInfo?.ui_meta as {nickname?: string} | undefined)?.nickname ||
    profileInfo?.description ||
    profile
  );
}

export function SessionListPanel({
  profile,
  onOpenSession,
  refreshTrigger,
}: {
  profile: string;
  onOpenSession: (opened: OpenedSession) => void;
  /** 外部请求刷新（桌面切 profile 等）；内容变化即触发，传值比较 */
  refreshTrigger?: number;
}) {
  const nicknameText = useProfileNickname(profile);
  const avatarUri = useProfilesStore(s => s.avatars[profile]);
  const sessions = useSessionsStore(s => s.byProfile[profile] ?? EMPTY_SESSIONS);
  const {refresh, remove} = useSessionsStore();
  const [filter, setFilter] = useState<SessionFilterCategory>('chats');

  // 面板挂载/切换 profile 时刷新（原屏幕 effect 行为保持）
  React.useEffect(() => {
    refresh(profile);
  }, [refresh, profile, refreshTrigger]);

  const filteredSessions = useMemo(
    () => sessions.filter(s => sourceBelongsToCategory(s.source, filter)),
    [sessions, filter],
  );

  const openSession = useCallback(
    async (row: SessionListRow) => {
      try {
        const opened = await openSessionFlow(profile, row);
        onOpenSession(opened);
      } catch (e) {
        alertError('打开会话失败', e instanceof Error ? e.message : String(e));
      }
    },
    [onOpenSession, profile],
  );

  const onDelete = useCallback(
    async (sessionId: string, title: string) => {
      const ok = await confirmDialog(
        '删除会话',
        `确定删除「${title || '未命名会话'}」吗？`,
      );
      if (!ok) {
        return;
      }
      try {
        await remove(profile, sessionId);
      } catch (e) {
        alertError('删除失败', e instanceof Error ? e.message : String(e));
      }
    },
    [profile, remove],
  );

  return (
    <View style={styles.container}>
      <View style={styles.filterBar}>
        {FILTER_OPTIONS.map(f => (
          <TouchableOpacity
            key={f.key}
            style={[styles.filterSeg, filter === f.key && styles.filterSegActive]}
            onPress={() => setFilter(f.key)}
            activeOpacity={0.8}>
            <Text
              style={[
                styles.filterText,
                filter === f.key && styles.filterTextActive,
              ]}>
              {f.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <FlatList
        data={filteredSessions}
        keyExtractor={s => s.id}
        refreshing={false}
        onRefresh={() => refresh(profile, true)}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {sessions.length === 0
              ? '还没有会话，点「新会话」开始'
              : '该分类下暂无会话'}
          </Text>
        }
        renderItem={({item}) => (
          <TouchableOpacity
            style={styles.row}
            activeOpacity={0.7}
            onPress={() => openSession(item)}
            onLongPress={() => onDelete(item.id, item.title)}>
            <Avatar name={nicknameText} uri={avatarUri} size={42} />
            <View style={styles.rowBody}>
              <View style={styles.rowTop}>
                <Text style={styles.title} numberOfLines={1}>
                  {item.title || '未命名会话'}
                </Text>
                {item.namespaced ? (
                  <Text style={styles.nsBadge}>QQ</Text>
                ) : null}
                {isAutomationSource(item.source) ? (
                  <Text style={styles.sourceBadge}>
                    {automationSourceLabel(item.source)}
                  </Text>
                ) : null}
                <Text style={styles.time}>{formatTime(item.started_at)}</Text>
              </View>
              <Text style={styles.preview} numberOfLines={1}>
                {item.preview || `${item.message_count} 条消息`}
              </Text>
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: Colors.card},
  filterBar: {
    flexDirection: 'row',
    marginTop: 12,
    marginHorizontal: 12,
    marginBottom: 8,
    backgroundColor: Colors.fill,
    borderRadius: 9,
    padding: 2,
  },
  filterSeg: {
    flex: 1,
    paddingVertical: 7,
    alignItems: 'center',
    borderRadius: 7,
  },
  filterSegActive: {backgroundColor: Colors.card},
  filterText: {fontSize: 13, color: Colors.textSecondary},
  filterTextActive: {color: Colors.text, fontWeight: '600'},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  rowBody: {flex: 1, marginLeft: 12},
  rowTop: {flexDirection: 'row', alignItems: 'center'},
  title: {fontSize: 15, fontWeight: '500', color: Colors.text, flex: 1},
  nsBadge: {
    fontSize: 10,
    color: Colors.textSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    marginLeft: 6,
    overflow: 'hidden',
  },
  sourceBadge: {
    fontSize: 10,
    color: Colors.accentDark,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.accent,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    marginLeft: 6,
    overflow: 'hidden',
  },
  time: {fontSize: 11, color: Colors.textSecondary, marginLeft: 8},
  preview: {fontSize: 13, color: Colors.textSecondary, marginTop: 2},
  sep: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.border,
    marginLeft: 68,
  },
  empty: {
    textAlign: 'center',
    color: Colors.textSecondary,
    marginTop: 60,
    fontSize: 14,
  },
});
