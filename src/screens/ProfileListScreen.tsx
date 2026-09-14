import React, {useEffect, useState} from 'react';
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
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {Avatar} from '../components/Avatar';
import {Colors} from '../components/theme';
import {LanguageToggle} from '../components/LanguageToggle';
import {ViewSwitcher, type HomeView} from '../components/ViewSwitcher';
import {useT} from '../i18n';
import {useLocaleStore} from '../i18n/localeStore';
import {CronPanel} from '../panels/CronPanel';
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
  const insets = useSafeAreaInsets();
  const t = useT();
  // 订阅生效语言：语言切换时重跑 setOptions，刷新 header 里的文案
  const locale = useLocaleStore(s => s.locale);
  const {list, avatars, loading, error, refresh} = useProfilesStore();
  const connState = useConnectionStore(s => s.state);
  const reconnecting = connState === 'reconnecting';
  // 主页视图：默认会话（profile 列表）；定时任务视图由 header 切换控件进入
  const [view, setView] = useState<HomeView>('sessions');

  useEffect(() => {
    refresh();
  }, [refresh]);

  // header：左上角「Hermes」标题位换成视图切换控件；右上角退出按钮保留
  useEffect(() => {
    navigation.setOptions({
      // 包一层 row 容器：原生 header 标题容器默认 stretch 会把胶囊根容器
      // 横向拉满标题区（右侧多出一段胶囊底色），包一层让它收回内容宽度
      headerTitle: () => (
        <View style={styles.headerSwitcher}>
          <ViewSwitcher value={view} onChange={setView} />
        </View>
      ),
      headerTitleAlign: 'left',
      headerRight: () => (
        <View style={styles.headerRight}>
          <LanguageToggle style={styles.langText} />
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() =>
              Alert.alert(
                t('profile.disconnectTitle'),
                t('profile.disconnectConfirm'),
                [
                  {text: t('common.cancel'), style: 'cancel'},
                  {
                    text: t('profile.disconnect'),
                    style: 'destructive',
                    onPress: () => {
                      useConnectionStore.getState().disconnect();
                    },
                  },
                ],
              )
            }>
            <Text style={styles.exitText}>{t('profile.disconnect')}</Text>
          </TouchableOpacity>
        </View>
      ),
    });
  }, [navigation, view, locale, t]);

  useEffect(() => {
    if (connState === 'disconnected') {
      navigation.replace('ConnectionHome');
    }
  }, [connState, navigation]);

  return (
    <View style={[styles.container, {paddingBottom: insets.bottom}]}>
      {reconnecting ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{t('profile.reconnecting')}</Text>
        </View>
      ) : null}
      {view === 'cron' ? (
        <CronPanel
          onCreate={() => navigation.navigate('CronEdit', {})}
          onEditJob={job =>
            navigation.navigate('CronEdit', {
              jobId: job.id,
              profile: job.profile,
            })
          }
          onOpenRuns={job =>
            navigation.navigate('CronRuns', {
              jobId: job.id,
              name: job.name,
              profile: job.profile,
            })
          }
        />
      ) : loading && list.length === 0 ? (
        <ActivityIndicator style={styles.loading} color={Colors.accent} />
      ) : error && list.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.error}>{t('profile.loadFailed', {error})}</Text>
          <TouchableOpacity onPress={() => refresh()} style={styles.retryBtn}>
            <Text style={styles.retryText}>{t('profile.retry')}</Text>
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
                  <Text style={styles.profileTag} numberOfLines={1}>
                    {item.name}
                  </Text>
                </View>
                <Text style={styles.preview} numberOfLines={1}>
                  {item.last_session?.preview ||
                    item.description ||
                    t('profile.skillCount', {count: item.skill_count ?? 0})}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.editBtn}
                hitSlop={8}
                onPress={() =>
                  navigation.navigate('ProfileEdit', {profile: item.name})
                }>
                <Text style={styles.editText}>{t('common.edit')}</Text>
              </TouchableOpacity>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: Colors.card},
  // 安卓原生 header 标题容器会把子级横向拉伸，包 row + 收窄到内容宽度
  headerSwitcher: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  headerRight: {flexDirection: 'row', alignItems: 'center'},
  langText: {fontSize: 15, color: Colors.text, marginRight: 16},
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
  profileTag: {
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
  editBtn: {
    marginLeft: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  editText: {fontSize: 13, color: Colors.textSecondary},
  sep: {height: StyleSheet.hairlineWidth, backgroundColor: Colors.border, marginLeft: 72},
});
