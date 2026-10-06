import React, {useCallback, useEffect} from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {Colors} from '../components/theme';
import {HeaderTitleView} from '../components/HeaderTitle';
import {useT} from '../i18n';
import {SessionListPanel, useProfileNickname} from '../panels/SessionListPanel';
import {createSessionFlow, type OpenedSession} from '../panels/sessionFlows';
import {useConnectionStore} from '../store/connection';
import {alertError} from '../utils/alert';
import type {RootStackParamList} from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'SessionList'>;
type Rt = RouteProp<RootStackParamList, 'SessionList'>;

export function SessionListScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const t = useT();
  const {profile} = route.params;
  const insets = useSafeAreaInsets();
  const nicknameText = useProfileNickname(profile);
  const connState = useConnectionStore(s => s.state);

  const onNewSession = useCallback(async () => {
    try {
      const opened = await createSessionFlow(profile);
      navigation.navigate('Chat', {
        sessionId: opened.sessionId,
        profile,
        title: opened.title,
      });
    } catch (e) {
      alertError(t('desktop.newSessionFailed'), e instanceof Error ? e.message : String(e));
    }
  }, [navigation, profile, t]);

  useEffect(() => {
    // title 置空 + 自定义 headerTitle：清零安卓原生 toolbar 的 72dp 标题缩进
    navigation.setOptions({
      title: '',
      headerTitleAlign: 'center',
      headerTitle: () => <HeaderTitleView title={nicknameText} />,
      headerRight: () => (
        <TouchableOpacity activeOpacity={0.7} onPress={onNewSession}>
          <Text style={styles.newSessionText}>{t('session.newTitle')}</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation, nicknameText, onNewSession, t]);

  const onOpenSession = useCallback(
    (opened: OpenedSession) => {
      navigation.navigate('Chat', {
        sessionId: opened.sessionId,
        profile,
        title: opened.title,
      });
    },
    [navigation, profile],
  );

  return (
    <View style={[styles.container, {paddingBottom: insets.bottom}]}>
      {/* 断线重连提示（ChatScreen/ProfileListScreen 同款横幅）：
          重连期间列表加载会等连接就绪，用户需要知道当前处于等待而非无数据 */}
      {connState === 'reconnecting' ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{t('profile.reconnecting')}</Text>
        </View>
      ) : null}
      <SessionListPanel profile={profile} onOpenSession={onOpenSession} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: Colors.card},
  newSessionText: {fontSize: 15, color: Colors.accent},
  banner: {
    backgroundColor: '#FFF7E8',
    paddingVertical: 6,
    alignItems: 'center',
  },
  bannerText: {fontSize: 12, color: '#FF7D00'},
});
