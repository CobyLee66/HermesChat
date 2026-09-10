import React from 'react';
import {StyleSheet, View} from 'react-native';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {Colors} from '../components/theme';
import {CronRunDetailPanel} from '../panels/CronRunDetailPanel';
import type {RootStackParamList} from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'CronRunDetail'>;
type Rt = RouteProp<RootStackParamList, 'CronRunDetail'>;

/** 定时任务运行详情页（导航栈）：只读展示该次运行的对话内容。 */
export function CronRunDetailScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const {run, name, profile} = route.params;
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.container, {paddingBottom: insets.bottom}]}>
      <CronRunDetailPanel
        run={run}
        jobName={name}
        onOpenChat={
          profile
            ? () =>
                navigation.navigate('Chat', {
                  sessionId: run.id,
                  profile,
                  title: run.title,
                })
            : undefined
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // 与导航 header 同为白色（screenOptions 的 contentStyle 灰底由本页覆盖）
  container: {flex: 1, backgroundColor: Colors.card},
});
