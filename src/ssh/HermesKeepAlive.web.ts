/**
 * HermesKeepAlive.web.ts — web/桌面打桩：前台保活是 Android 原生能力，
 * web（浏览器直连）与桌面（Electron 主进程常驻）不需要，全部 no-op。
 * vite 的 `.web.ts` 优先解析保证 PermissionsAndroid 不进 web 包
 * （react-native-web 无此导出）。
 */

export const isAvailable = false;

export async function start(_title: string, _body: string): Promise<void> {}

export async function stop(): Promise<void> {}
