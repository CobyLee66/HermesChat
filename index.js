/**
 * @format
 */

import React from 'react';
import {AppRegistry, StyleSheet} from 'react-native';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import App from './App';
import { name as appName } from './app.json';

// RNGH 的手势编排器挂在根节点上先于 Android 原生触摸拦截链裁决手势
// （markdown 表格横向拖动修复的前提，见 DECISIONS.md D039）。
// 只在原生入口引入；web/desktop 渲染层入口（web/index.web.js）不受影响。
function Root() {
  return (
    <GestureHandlerRootView style={styles.flex}>
      <App />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({flex: {flex: 1}});

AppRegistry.registerComponent(appName, () => Root);
