/**
 * web 渲染层诊断安装（仅 Electron 桌面生效；普通浏览器保持零开销）。
 *
 * 为「桌面端后台几分钟后整窗空白」排查安装三类探针：
 * 1. 全局 error / unhandledrejection 监听——JS 层异常留痕；
 * 2. 页面可见性变化——对齐主进程窗口最小化/还原时间线；
 * 3. 30s 心跳——连接状态 + 可见性 + JS 堆。后台被 Chromium 节流时心跳间隔
 *    拉长（这本身就是节流证据）；心跳持续而窗口空白 = JS 活着、绘制停了。
 *
 * window/document 未进类型（tsconfig 无 dom lib），沿用仓库惯例经 globalThis 断言。
 */

import {hasRpc} from '../rpc/runtime';
import {hasDesktopBridge} from '../ssh/desktopHermesSsh';
import {useConnectionStore} from '../store/connection';
import {dlog} from './desktopLog';

interface WebGlobals {
  addEventListener: (
    type: string,
    listener: (e: {
      message?: string;
      filename?: string;
      lineno?: number;
      colno?: number;
      reason?: unknown;
    }) => void,
  ) => void;
  document: {
    addEventListener?: (type: string, listener: () => void) => void;
    visibilityState?: string;
    hasFocus?: () => boolean;
  };
}

export function installWebDiagnostics(): void {
  if (!hasDesktopBridge()) {
    return;
  }
  const g = globalThis as unknown as Partial<WebGlobals>;
  if (!g.addEventListener || !g.document) {
    return; // 非 web 环境（理论上不可达：桌面构建必为 web）
  }
  dlog('INFO', '渲染层启动，诊断探针已安装');

  g.addEventListener('error', e => {
    dlog(
      'ERROR',
      `window error：${e.message ?? 'unknown'} @ ${e.filename ?? '?'}:${e.lineno ?? '?'}:${e.colno ?? '?'}`,
    );
  });
  g.addEventListener('unhandledrejection', e => {
    dlog('ERROR', `unhandledrejection：${String(e.reason)}`);
  });
  g.document.addEventListener?.('visibilitychange', () => {
    dlog('INFO', `页面可见性：${g.document?.visibilityState ?? '?'}`);
  });

  const heapSuffix = () => {
    const used = (
      globalThis as {performance?: {memory?: {usedJSHeapSize: number}}}
    ).performance?.memory?.usedJSHeapSize;
    return used ? ` heap=${Math.round(used / 1048576)}MB` : '';
  };
  setInterval(() => {
    const st = useConnectionStore.getState();
    dlog(
      'INFO',
      `心跳 state=${st.state} vis=${g.document?.visibilityState ?? '?'} ` +
        `focus=${g.document?.hasFocus?.() ?? '?'} ws=${hasRpc() ? 'open' : 'closed'}${heapSuffix()}`,
    );
  }, 30_000);
}
