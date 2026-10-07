/**
 * openExternalUrl — 打开外部链接（about 页 GitHub 链接等）。
 *
 * 三类运行环境一条代码路径：
 * - Electron 桌面：委托主进程 shell.openExternal（系统浏览器，限 http/https）；
 * - 原生 / 普通浏览器：RN Linking.openURL（RNW 在浏览器里开新标签）。
 */

import {Linking} from 'react-native';

import {getDesktopBridge} from '../ssh/desktopHermesSsh';

export async function openExternalUrl(url: string): Promise<void> {
  const bridge = getDesktopBridge();
  if (bridge) {
    await bridge.openExternal(url);
    return;
  }
  await Linking.openURL(url);
}
