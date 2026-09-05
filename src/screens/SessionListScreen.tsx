import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {Avatar} from '../components/Avatar';
import {Colors} from '../components/theme';
import {HeaderTitleView} from '../components/HeaderTitle';
import {getExecRemote} from '../ssh/execRemote';
import {fetchRemoteHistory} from '../ssh/remoteHistory';
import {useChatStore} from '../store/chat';
import {getFork} from '../store/forkMap';
import {useProfilesStore} from '../store/profiles';
import {useSessionsStore} from '../store/sessions';
import {
  automationSourceLabel,
  isAutomationSource,
  sourceBelongsToCategory,
  type SessionFilterCategory,
} from '../utils/sessionSources';
import type {SessionListRow} from '../rpc/types';
import type {RootStackParamList} from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'SessionList'>;
type Rt = RouteProp<RootStackParamList, 'SessionList'>;

// zustand 选择器必须返回稳定引用：`?? []` 每次新建数组会让
// useSyncExternalStore 认为 store 一直在变 → 无限重渲染崩溃
const EMPTY_SESSIONS: SessionListRow[] = [];

// 过滤口径对齐 hermes web dashboard：默认只看普通聊天（见 sessionSources.ts）
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

export function SessionListScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const {profile} = route.params;
  const insets = useSafeAreaInsets();

  const profileInfo = useProfilesStore(s =>
    s.list.find(p => p.name === profile),
  );
  const profileList = useProfilesStore(s => s.list);
  const avatarUri = useProfilesStore(s => s.avatars[profile]);
  const sessions = useSessionsStore(s => s.byProfile[profile] ?? EMPTY_SESSIONS);
  const {refresh, remove, create, resume} = useSessionsStore();
  const attach = useChatStore(s => s.attach);
  const [filter, setFilter] = useState<SessionFilterCategory>('chats');

  const filteredSessions = useMemo(
    () => sessions.filter(s => sourceBelongsToCategory(s.source, filter)),
    [sessions, filter],
  );

  const nicknameText =
    (profileInfo?.ui_meta as {nickname?: string} | undefined)?.nickname ||
    profileInfo?.description ||
    profile;

  const onNewSession = useCallback(async () => {
    try {
      const result = await create(profile);
      attach(result.session_id, {
        messages: result.messages ?? [],
        info: result.info,
        profile,
        storedSessionId: result.stored_session_id,
      });
      navigation.navigate('Chat', {
        sessionId: result.session_id,
        profile,
        title: '新会话',
      });
    } catch (e) {
      Alert.alert('新建会话失败', e instanceof Error ? e.message : String(e));
    }
  }, [attach, create, navigation, profile]);

  useEffect(() => {
    // title 置空 + 自定义 headerTitle：清零安卓原生 toolbar 的 72dp 标题缩进
    navigation.setOptions({
      title: '',
      headerTitleAlign: 'center',
      headerTitle: () => <HeaderTitleView title={nicknameText} />,
      headerRight: () => (
        <TouchableOpacity activeOpacity={0.7} onPress={onNewSession}>
          <Text style={styles.newSessionText}>新会话</Text>
        </TouchableOpacity>
      ),
    });
    refresh(profile);
  }, [navigation, nicknameText, onNewSession, refresh, profile]);

  const openSession = useCallback(
    async (row: SessionListRow) => {
      const title = row.title;
      try {
        // foreign 会话（multiplex 大库，物理不在本 profile 库）：
        // 有 fork 记录 → fork 是 own 会话，走正常 resume；
        // 否则不 resume（避免错人格 agent），经 SSH exec 只读 sqlite 展示，
        // 首次发送时再派生（见 chat store forkForeignAndSend）。
        if (row.namespaced && row.hostProfile && row.hostProfile !== profile) {
          const fork = await getFork(row.id, profile);
          if (fork) {
            const result = await resume(profile, fork.forkId);
            attach(result.session_id, {
              messages: result.messages ?? [],
              info: result.info,
              profile,
              storedSessionId: result.stored_session_id ?? fork.forkId,
              pendingApprovals: result.pending_approval,
              pendingClarifies: result.pending_clarify,
              running: result.running,
              inflight: result.inflight,
            });
            navigation.navigate('Chat', {
              sessionId: result.session_id,
              profile,
              title: title || '会话',
            });
            return;
          }
          const exec = getExecRemote();
          const hostPath = profileList.find(
            p => p.name === row.hostProfile,
          )?.path;
          if (!exec || !hostPath) {
            throw new Error('需要 SSH 连接才能读取该会话的历史');
          }
          const messages = await fetchRemoteHistory(
            exec,
            `${hostPath}/state.db`,
            row.id,
          );
          attach(row.id, {
            messages,
            profile,
            storedSessionId: row.id,
            foreign: {originId: row.id, hostProfile: row.hostProfile},
          });
          navigation.navigate('Chat', {
            sessionId: row.id,
            profile,
            title: title || '会话',
          });
          return;
        }
        const result = await resume(profile, row.id);
        const liveSid = result.session_id;
        attach(liveSid, {
          messages: result.messages ?? [],
          info: result.info,
          profile,
          storedSessionId: result.stored_session_id ?? row.id,
          pendingApprovals: result.pending_approval,
          pendingClarifies: result.pending_clarify,
          // turn 进行中（如 cron/QQ 侧发起的回合）：恢复流式尾部实时续流
          running: result.running,
          inflight: result.inflight,
        });
        navigation.navigate('Chat', {
          sessionId: liveSid,
          profile,
          title: title || '会话',
        });
      } catch (e) {
        Alert.alert('打开会话失败', e instanceof Error ? e.message : String(e));
      }
    },
    [attach, navigation, profile, profileList, resume],
  );

  const onDelete = useCallback(
    (sessionId: string, title: string) => {
      Alert.alert('删除会话', `确定删除「${title || '未命名会话'}」吗？`, [
        {text: '取消', style: 'cancel'},
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            remove(profile, sessionId).catch(e =>
              Alert.alert('删除失败', e instanceof Error ? e.message : String(e)),
            );
          },
        },
      ]);
    },
    [profile, remove],
  );

  return (
    <View style={[styles.container, {paddingBottom: insets.bottom}]}>
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
            {sessions.length === 0 ? '还没有会话，点右上角「新会话」开始' : '该分类下暂无会话'}
          </Text>
        }
        renderItem={({item}) => (
          <TouchableOpacity
            style={styles.row}
            activeOpacity={0.7}
            onPress={() => openSession(item)}
            onLongPress={() => onDelete(item.id, item.title)}>
            <Avatar
              name={nicknameText}
              uri={avatarUri}
              size={42}
            />
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
  newSessionText: {fontSize: 15, color: Colors.accent},
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
  sep: {height: StyleSheet.hairlineWidth, backgroundColor: Colors.border, marginLeft: 68},
  empty: {
    textAlign: 'center',
    color: Colors.textSecondary,
    marginTop: 60,
    fontSize: 14,
  },
});
