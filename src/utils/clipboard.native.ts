/**
 * 剪贴板写入 — 原生实现（Metro 平台解析优先 .native.ts，vite 构建不会拉本文件，
 * 原生包不会被 web 打包）。RN 0.87 核心已无 Clipboard，用社区包。
 */

import Clipboard from '@react-native-clipboard/clipboard';

export function copyText(text: string): Promise<void> {
  Clipboard.setString(text);
  return Promise.resolve();
}
