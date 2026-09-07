/* eslint-env browser */
/**
 * web 入口（vite root=web，由 index.html 引用；Metro 原生入口仍是 ../index.js）。
 */
import {AppRegistry} from 'react-native';
import {createElement} from 'react';

import App from '../App';
import {ErrorBoundary} from '../src/components/ErrorBoundary';
import {installWebDiagnostics} from '../src/utils/webDiagnostics';
import {name as appName} from '../app.json';

// 桌面端白屏排查：安装诊断探针（仅 Electron 生效），render 异常不再静默白屏
installWebDiagnostics();
const WrappedApp = () => createElement(ErrorBoundary, null, createElement(App));

AppRegistry.registerComponent(appName, () => WrappedApp);
AppRegistry.runApplication(appName, {
  rootTag: document.getElementById('root'),
});
