/**
 * HermesMobile — Hermes Agent 手机端。
 * 导航：ConnectionHome → ConnectionEdit / ProfileList → SessionList → Chat。
 */

import React, {useEffect} from 'react';
import {StatusBar} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackNavigationOptions,
} from '@react-navigation/native-stack';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {enableScreens} from 'react-native-screens';

import {Colors} from './src/components/theme';
import {ChatScreen} from './src/screens/ChatScreen';
import {ConnectionEditScreen} from './src/screens/ConnectionEditScreen';
import {ConnectionHomeScreen} from './src/screens/ConnectionHomeScreen';
import {ProfileListScreen} from './src/screens/ProfileListScreen';
import {SessionListScreen} from './src/screens/SessionListScreen';
import {initConnectionEngine} from './src/ssh/SshManager';
import {useConnectionStore} from './src/store/connection';
import type {RootStackParamList} from './src/navigation/types';

enableScreens();

const Stack = createNativeStackNavigator<RootStackParamList>();

const screenOptions: NativeStackNavigationOptions = {
  headerStyle: {backgroundColor: Colors.card},
  headerTintColor: Colors.text,
  headerTitleStyle: {fontSize: 17, fontWeight: '600'},
  contentStyle: {backgroundColor: Colors.bg},
};

function App() {
  const state = useConnectionStore(s => s.state);

  useEffect(() => {
    initConnectionEngine();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <NavigationContainer>
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
            options={{title: 'Hermes', headerBackVisible: false}}
          />
          <Stack.Screen name="SessionList" component={SessionListScreen} />
          <Stack.Screen name="Chat" component={ChatScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

export default App;
