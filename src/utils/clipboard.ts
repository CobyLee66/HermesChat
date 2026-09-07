/**
 * 剪贴板写入 — web/桌面实现（vite 构建解析本文件；Metro 解析 .native 变体）。
 * RNW 无 RN Clipboard 模块，走浏览器剪贴板（结构类型断言，项目无 DOM lib）。
 */

export function copyText(text: string): Promise<void> {
  const clipboard = (globalThis as {
    navigator?: {clipboard?: {writeText?: (t: string) => Promise<void>}};
  }).navigator?.clipboard;
  return clipboard?.writeText?.(text) ?? Promise.resolve();
}
