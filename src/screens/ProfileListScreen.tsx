import React, {useEffect} from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';

import {Avatar} from '../components/Avatar';
import {Colors} from '../components/theme';
import {useConnectionStore} from '../store/connection';
import {useProfilesStore} from '../store/profiles';
import type {ProfileInfo} from '../rpc/types';
import type {RootStackParamList} from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'ProfileList'>;

/** profile 昵称：ui_meta.nickname > description 首行 > name */
function nickname(p: ProfileInfo): string {
  const meta = p.ui_meta as {nickname?: string} | undefined;
  return meta?.nickname || p.description?.split('\n')[0] || p.name;
}

export function ProfileListScreen() {
  const navigation = useNavigation<Nav>();
  const {list, avatars, loading, error, refresh} = useProfilesStore();
  const connState = useConnectionStore(s => s.state);
  const reconnecting = connState === 'reconnecting';

  useEffect(() => {
    refresh();
  }, [refresh]);

  // header 右上角"退出"：确认后断开连接，由下方 effect 带回 ConnectionHome
  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() =>
            Alert.alert('退出连接', '确定断开与主机的连接吗？', [
              {text: '取消', style: 'cancel'},
              {
                text: '退出',
                style: 'destructive',
                onPress: () => {
                  useConnectionStore.getState().disconnect();
                },
              },
            ])
          }>
          <Text style={styles.exitText}>退出</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation]);

  useEffect(() => {
    if (connState === 'disconnected') {
      navigation.replace('ConnectionHome');
    }
  }, [connState, navigation]);

  return (
    <View style={styles.container}>
      {reconnecting ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>连接已断开，正在重连…</Text>
        </View>
      ) : null}
      {loading && list.length === 0 ? (
        <ActivityIndicator style={styles.loading} color={Colors.accent} />
      ) : error && list.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.error}>加载失败：{error}</Text>
          <TouchableOpacity onPress={() => refresh()} style={styles.retryBtn}>
            <Text style={styles.retryText}>重试</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={list}
          keyExtractor={p => p.name}
          refreshing={loading}
          onRefresh={() => refresh()}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          renderItem={({item}) => (
            <TouchableOpacity
              style={styles.row}
              activeOpacity={0.7}
              onPress={() =>
                navigation.navigate('SessionList', {profile: item.name})
              }>
              <Avatar name={nickname(item)} uri={avatars[item.name]} size={46} />
              <View style={styles.rowBody}>
                <View style={styles.rowTop}>
                  <Text style={styles.name}>{nickname(item)}</Text>
                  {item.model ? (
                    <Text style={styles.modelTag} numberOfLines={1}>
                      {item.model}
                    </Text>
                  ) : null}
                </View>
                <Text style={styles.preview} numberOfLines={1}>
                  {item.last_session?.preview ||
                    item.description ||
                    `${item.skill_count ?? 0} 个技能`}
                </Text>
              </View>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: Colors.card},
  loading: {marginTop: 48},
  banner: {
    backgroundColor: '#FFF7E8',
    paddingVertical: 6,
    alignItems: 'center',
  },
  bannerText: {fontSize: 12, color: '#FF7D00'},
  exitText: {fontSize: 15, color: Colors.danger},
  emptyWrap: {alignItems: 'center', marginTop: 48},
  error: {color: Colors.danger, fontSize: 14},
  retryBtn: {
    marginTop: 12,
    backgroundColor: Colors.accent,
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  retryText: {color: '#FFF', fontSize: 14},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 11,
    backgroundColor: Colors.card,
  },
  rowBody: {flex: 1, marginLeft: 12},
  rowTop: {flexDirection: 'row', alignItems: 'center'},
  name: {fontSize: 16, fontWeight: '500', color: Colors.text, flexShrink: 1},
  modelTag: {
    fontSize: 10,
    color: Colors.accentDark,
    backgroundColor: '#E8F7FF',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    marginLeft: 8,
    flexShrink: 1,
  },
  preview: {fontSize: 13, color: Colors.textSecondary, marginTop: 3},
  sep: {height: StyleSheet.hairlineWidth, backgroundColor: Colors.border, marginLeft: 72},
});
