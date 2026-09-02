import React, {useEffect} from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';

import {
  useConnectionStore,
  type ConnectionProfile,
} from '../store/connection';
import {connectWebDirect} from '../ssh/webDirect';
import {Colors} from '../components/theme';
import type {RootStackParamList} from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'ConnectionHome'>;

/**
 * 模块级标记：自动连接只尝试一次。
 * 失败后置位 → 停留在本页显示错误，不会因重渲染/重进页面陷入失败重试死循环。
 */
let autoConnectAttempted = false;

export function ConnectionHomeScreen() {
  const navigation = useNavigation<Nav>();
  const {
    profiles,
    currentProfileId,
    autoProfileId,
    state,
    error,
    connect,
    removeProfile,
    loadPersisted,
  } = useConnectionStore();

  // 载入持久化配置后，若有"打开应用后自动连接"的配置且处于 disconnected，自动连一次
  useEffect(() => {
    let cancelled = false;
    loadPersisted().then(() => {
      if (cancelled || autoConnectAttempted) {
        return;
      }
      const s = useConnectionStore.getState();
      if (
        s.autoProfileId &&
        s.state === 'disconnected' &&
        s.profiles.some(p => p.id === s.autoProfileId)
      ) {
        autoConnectAttempted = true;
        s.connect(s.autoProfileId);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadPersisted]);

  useEffect(() => {
    if (state === 'ready') {
      navigation.replace('ProfileList');
    }
  }, [state, navigation]);

  const connecting = state === 'connecting' || state === 'bootstrapping';

  const confirmRemove = (p: ConnectionProfile) => {
    Alert.alert('删除配置', `确定删除「${p.name}」吗？`, [
      {text: '取消', style: 'cancel'},
      {
        text: '删除',
        style: 'destructive',
        onPress: () => removeProfile(p.id),
      },
    ]);
  };

  return (
    <View style={styles.flex}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.logo}>Hermes</Text>
        <Text style={styles.subtitle}>选择配置，连接到你的 Hermes Agent</Text>

        {profiles.length === 0 ? (
          <Text style={styles.empty}>暂无连接配置，点击下方按钮添加</Text>
        ) : (
          profiles.map(p => (
            <TouchableOpacity
              key={p.id}
              style={styles.card}
              activeOpacity={0.75}
              disabled={connecting}
              onPress={() => {
                connect(p.id);
              }}>
              <View style={styles.cardBody}>
                <View style={styles.cardTop}>
                  <Text style={styles.cardName}>{p.name}</Text>
                  {p.id === autoProfileId ? (
                    <Text style={styles.defaultTag}>默认</Text>
                  ) : null}
                </View>
                <Text style={styles.cardAddr}>
                  {p.username}@{p.host}:{p.port}
                </Text>
              </View>
              {connecting && p.id === currentProfileId ? (
                <ActivityIndicator color={Colors.accent} />
              ) : (
                <View style={styles.cardActions}>
                  <TouchableOpacity
                    style={styles.actionBtn}
                    onPress={() =>
                      navigation.navigate('ConnectionEdit', {profileId: p.id})
                    }>
                    <Text style={styles.editText}>编辑</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.actionBtn}
                    onPress={() => confirmRemove(p)}>
                    <Text style={styles.deleteText}>🗑</Text>
                  </TouchableOpacity>
                </View>
              )}
            </TouchableOpacity>
          ))
        )}

        {error ? <Text style={styles.error}>⚠ {error}</Text> : null}

        {state === 'reconnecting' ? (
          <Text style={styles.reconnecting}>连接已断开，正在重连…</Text>
        ) : null}

        {Platform.OS === 'web' ? (
          <TouchableOpacity
            style={styles.directButton}
            activeOpacity={0.8}
            disabled={connecting}
            onPress={() => {
              connectWebDirect();
            }}>
            <Text style={styles.directButtonText}>
              ⚡ 浏览器直连（本机 127.0.0.1:9119）
            </Text>
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity
          style={styles.addButton}
          activeOpacity={0.8}
          onPress={() => navigation.navigate('ConnectionEdit', {})}>
          <Text style={styles.addButtonText}>＋ 添加配置</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {flex: 1, backgroundColor: Colors.bg},
  container: {padding: 24, paddingTop: 60},
  logo: {
    fontSize: 34,
    fontWeight: '700',
    color: Colors.accent,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: 6,
    marginBottom: 28,
  },
  empty: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginVertical: 32,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
  },
  cardBody: {flex: 1},
  cardTop: {flexDirection: 'row', alignItems: 'center'},
  cardName: {
    fontSize: 16,
    fontWeight: '600',
    color: Colors.text,
    flexShrink: 1,
  },
  defaultTag: {
    fontSize: 10,
    color: Colors.accentDark,
    backgroundColor: '#E8F7FF',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    marginLeft: 8,
  },
  cardAddr: {fontSize: 13, color: Colors.textSecondary, marginTop: 3},
  cardActions: {flexDirection: 'row', alignItems: 'center', marginLeft: 10},
  actionBtn: {paddingHorizontal: 6, paddingVertical: 4},
  editText: {fontSize: 14, color: Colors.accent},
  deleteText: {fontSize: 16},
  addButton: {
    backgroundColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 14,
  },
  addButtonText: {color: '#FFF', fontSize: 16, fontWeight: '600'},
  directButton: {
    backgroundColor: Colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.accent,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 14,
  },
  directButtonText: {color: Colors.accentDark, fontSize: 15, fontWeight: '600'},
  error: {color: Colors.danger, fontSize: 13, marginTop: 4},
  reconnecting: {
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: 12,
  },
});
