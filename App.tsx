/**
 * HermesChat — Hermes Agent 手机端。
 * 导航：ConnectionHome → ConnectionEdit / ProfileList → SessionList → Chat。
 */

import React, {useEffect} from 'react';
import {Platform, StatusBar} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackNavigationOptions,
} from '@react-navigation/native-stack';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {enableScreens} from 'react-native-screens';

import {Colors} from './src/components/theme';
import {DesktopApp} from './src/desktop/DesktopApp';
import {ChatScreen} from './src/screens/ChatScreen';
import {ConnectionEditScreen} from './src/screens/ConnectionEditScreen';
import {ConnectionHomeScreen} from './src/screens/ConnectionHomeScreen';
import {CronEditScreen} from './src/screens/CronEditScreen';
import {CronRunsScreen} from './src/screens/CronRunsScreen';
import {ProfileEditScreen} from './src/screens/ProfileEditScreen';
import {ProfileListScreen} from './src/screens/ProfileListScreen';
import {SessionListScreen} from './src/screens/SessionListScreen';
import {hasDesktopBridge, initDesktopEngine} from './src/ssh/desktopBridge';
import {initConnectionEngine} from './src/ssh/SshManager';
import {initWebDirectEngine} from './src/ssh/webDirect';
import {useConnectionStore} from './src/store/connection';
import {useSessionsStore} from './src/store/sessions';
import type {RootStackParamList} from './src/navigation/types';

enableScreens();

const Stack = createNativeStackNavigator<RootStackParamList>();

const screenOptions: NativeStackNavigationOptions = {
  headerStyle: {backgroundColor: Colors.card},
  headerTintColor: Colors.text,
  headerTitleStyle: {fontSize: 15, fontWeight: '600'},
  contentStyle: {backgroundColor: Colors.bg},
};

function App() {
  const state = useConnectionStore(s => s.state);
  // web 构建连接就绪后用响应式桌面壳（三栏/两栏/单列按窗口宽度自适应）；
  // 原生构建始终走导航栈；连接期（未就绪/断开）所有平台都是导航栈连接页。
  const desktopShell =
    Platform.OS === 'web' && (state === 'ready' || state === 'reconnecting');

  useEffect(() => {
    // 排序档位持久化恢复（进会话列表前完成，避免首帧闪默认档）
    useSessionsStore.getState().loadSortModePreference();
    // web 构建按环境装配：Electron 桌面桥（ssh2 隧道）或浏览器直连引擎
    if (Platform.OS === 'web') {
      if (hasDesktopBridge()) {
        initDesktopEngine();
      } else {
        initWebDirectEngine();
      }
    } else {
      initConnectionEngine();
    }
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      {desktopShell ? (
        <DesktopApp />
      ) : (
        // documentTitle 关掉 web 端 react-navigation 逐屏改写 window.title 的默认行为
        // （ConnectionHome 的 title「连接」会一直留在窗口标题上，桌面壳接管后再没人改），
        // 窗口标题统一保持 index.html 的「Hermes Chat」
        <NavigationContainer documentTitle={{enabled: false}}>
          <Stack.Navigator
            screenOptions={screenOptions}
            initialRouteName={
              state === 'ready' || state === 'reconnecting'
                ? 'ProfileList'
                : 'ConnectionHome'
            }>
            <Stack.Screen
              name="ConnectionHome"
              component={ConnectionHomeScreen}
              options={{title: '连接', headerShown: false}}
            />
            <Stack.Screen
              name="ConnectionEdit"
              component={ConnectionEditScreen}
              options={({route}) => ({
                title: route.params?.profileId ? '编辑配置' : '添加配置',
              })}
            />
            <Stack.Screen
              name="ProfileList"
              component={ProfileListScreen}
              // 左上角标题位由 ProfileListScreen 注入视图切换控件（会话 | 定时任务）
              options={{title: '', headerBackVisible: false}}
            />
            <Stack.Screen
              name="ProfileEdit"
              component={ProfileEditScreen}
              options={{title: '编辑资料'}}
            />
            <Stack.Screen name="SessionList" component={SessionListScreen} />
            <Stack.Screen name="Chat" component={ChatScreen} />
            <Stack.Screen
              name="CronRuns"
              component={CronRunsScreen}
              options={{title: '运行历史'}}
            />
            <Stack.Screen
              name="CronEdit"
              component={CronEditScreen}
              options={{title: '定时任务'}}
            />
          </Stack.Navigator>
        </NavigationContainer>
      )}
    </SafeAreaProvider>
  );
}

export default App;
