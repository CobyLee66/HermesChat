/**
 * @format
 */

import React from 'react';
import {AppRegistry, StyleSheet} from 'react-native';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import App from './App';
import {ErrorBoundary} from './src/components/ErrorBoundary';
import { name as appName } from './app.json';

// 未捕获 JS 异常留痕（「切后台再回前台偶发崩溃」排查）：release 包的默认
// 处理器会把异常 rethrow 到原生层杀进程，先 console.error 落完整栈
// （logcat 的 ReactNativeJS 段可见），再交还默认处理器保持原有崩溃语义。
// 渲染异常走 ErrorBoundary（更早捕获、不杀进程），到不了这里。
// ErrorUtils 是 RN InitializeCore 注入的全局，不在 react-native 导出里。
/* global ErrorUtils */
if (typeof ErrorUtils !== 'undefined') {
  const prevHandler = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    console.error(
      `[HermesChat] 未捕获 JS 异常（isFatal=${String(isFatal)}）：`,
      error && error.stack ? error.stack : String(error),
    );
    prevHandler(error, isFatal);
  });
}

// RNGH 的手势编排器挂在根节点上先于 Android 原生触摸拦截链裁决手势
// （markdown 表格横向拖动修复的前提，见 DECISIONS.md D039）。
// ErrorBoundary 对齐 web 入口（web/index.web.js）：渲染异常降级为可见
// 错误卡（componentDidCatch 有 dlog），不再直接杀进程。
// 只在原生入口引入；web/desktop 渲染层入口（web/index.web.js）不受影响。
function Root() {
  return (
    <GestureHandlerRootView style={styles.flex}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({flex: {flex: 1}});

AppRegistry.registerComponent(appName, () => Root);
