import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {Colors} from '../components/theme';
import {CronRunsPanel} from '../panels/CronRunsPanel';
import type {RootStackParamList} from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'CronRuns'>;
type Rt = RouteProp<RootStackParamList, 'CronRuns'>;

/** 定时任务运行历史页（导航栈）：列表 + 点记录进运行详情页。 */
export function CronRunsScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const {jobId, name, profile} = route.params;
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.container, {paddingBottom: insets.bottom}]}>
      <Text style={styles.jobName} numberOfLines={1}>
        {name}
      </Text>
      <CronRunsPanel
        jobId={jobId}
        profile={profile}
        onOpenRun={run =>
          navigation.navigate('CronRunDetail', {
            run,
            name,
            profile: run.profile ?? profile,
          })
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: Colors.card},
  jobName: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginHorizontal: 14,
    marginTop: 10,
  },
});
