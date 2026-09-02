import React, {useCallback, useEffect} from 'react';
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

import {Avatar} from '../components/Avatar';
import {Colors} from '../components/theme';
import {getExecRemote} from '../ssh/execRemote';
import {fetchRemoteHistory} from '../ssh/remoteHistory';
import {useChatStore} from '../store/chat';
import {getFork} from '../store/forkMap';
import {useProfilesStore} from '../store/profiles';
import {useSessionsStore} from '../store/sessions';
import type {SessionListRow} from '../rpc/types';
import type {RootStackParamList} from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'SessionList'>;
type Rt = RouteProp<RootStackParamList, 'SessionList'>;

// zustand 选择器必须返回稳定引用：`?? []` 每次新建数组会让
// useSyncExternalStore 认为 store 一直在变 → 无限重渲染崩溃
const EMPTY_SESSIONS: SessionListRow[] = [];

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

  const profileInfo = useProfilesStore(s =>
    s.list.find(p => p.name === profile),
  );
  const profileList = useProfilesStore(s => s.list);
  const avatarUri = useProfilesStore(s => s.avatars[profile]);
  const sessions = useSessionsStore(s => s.byProfile[profile] ?? EMPTY_SESSIONS);
  const {refresh, remove, create, resume} = useSessionsStore();
  const attach = useChatStore(s => s.attach);

  const nicknameText =
    (profileInfo?.ui_meta as {nickname?: string} | undefined)?.nickname ||
    profileInfo?.description ||
    profile;

  useEffect(() => {
    navigation.setOptions({title: nicknameText});
    refresh(profile);
  }, [navigation, nicknameText, refresh, profile]);

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
    <View style={styles.container}>
      <TouchableOpacity style={styles.newBtn} onPress={onNewSession} activeOpacity={0.8}>
        <Text style={styles.newBtnText}>＋ 新建会话</Text>
      </TouchableOpacity>
      <FlatList
        data={sessions}
        keyExtractor={s => s.id}
        refreshing={false}
        onRefresh={() => refresh(profile, true)}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        ListEmptyComponent={
          <Text style={styles.empty}>还没有会话，点上方新建一个吧</Text>
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
  newBtn: {
    margin: 12,
    backgroundColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
  },
  newBtnText: {color: '#FFF', fontSize: 15, fontWeight: '600'},
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
