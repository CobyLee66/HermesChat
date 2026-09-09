import React, {useEffect} from 'react';
import {ActivityIndicator, StyleSheet, Text, View} from 'react-native';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {Colors} from '../components/theme';
import {CronJobForm, useCronJobDraft} from '../panels/CronJobForm';
import {useCronStore} from '../store/cron';
import {useProfilesStore} from '../store/profiles';
import {useKeyboardHeight} from '../utils/useKeyboardHeight';
import type {RootStackParamList} from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'CronEdit'>;
type Rt = RouteProp<RootStackParamList, 'CronEdit'>;

/** 定时任务新建/编辑页（导航栈；表单体与桌面 Modal 共用 CronJobForm）。 */
export function CronEditScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const {jobId, profile} = route.params;
  const insets = useSafeAreaInsets();
  const {bottomPad} = useKeyboardHeight();
  const {job, error} = useCronJobDraft(jobId, profile);
  const profileList = useProfilesStore(s => s.list);

  useEffect(() => {
    navigation.setOptions({title: jobId ? '编辑定时任务' : '新建定时任务'});
  }, [navigation, jobId]);

  if (jobId && !job && !error) {
    return (
      <View style={styles.centerWrap}>
        <ActivityIndicator color={Colors.accent} />
      </View>
    );
  }
  if (jobId && !job) {
    return (
      <View style={styles.centerWrap}>
        <Text style={styles.error}>任务不存在或已被删除：{error}</Text>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.container,
        {paddingBottom: insets.bottom + bottomPad},
      ]}>
      <CronJobForm
        job={job}
        profiles={profileList.map(p => p.name)}
        defaultProfile={profile}
        onSaved={() => {
          void useCronStore.getState().refresh({silent: true});
          navigation.goBack();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: Colors.bg},
  centerWrap: {
    flex: 1,
    backgroundColor: Colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  error: {color: Colors.danger, fontSize: 14, textAlign: 'center'},
});
