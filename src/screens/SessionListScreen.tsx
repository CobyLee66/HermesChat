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
import {useChatStore} from '../store/chat';
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
    async (sessionId: string, title: string) => {
      try {
        const result = await resume(profile, sessionId);
        const liveSid = result.session_id;
        attach(liveSid, {
          messages: result.messages ?? [],
          info: result.info,
          profile,
          storedSessionId: result.stored_session_id ?? sessionId,
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
    [attach, navigation, profile, resume],
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
            onPress={() => openSession(item.id, item.title)}
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
