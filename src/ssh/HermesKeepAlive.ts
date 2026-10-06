/**
 * HermesKeepAlive.ts — 后台保活前台服务的 JS typed wrapper（契约见 docs/ssh-module.md §7）。
 *
 * 封装 NativeModules.HermesKeepAlive（Android 前台服务 + partial wake lock）：
 * - start/stop 均幂等：重复 start 仅刷新通知文案；stop 在服务未运行时也成功；
 * - 原生模块缺失（web / 桌面 / Jest / 未链接的构建）时 isAvailable=false，
 *   方法调用静默 no-op，绝不抛同步异常——连接流程在各平台行为一致。
 */

import {NativeModules, PermissionsAndroid, Platform} from 'react-native';

interface NativeHermesKeepAliveModule {
  start(title: string, body: string): Promise<void>;
  stop(): Promise<void>;
}

const native: NativeHermesKeepAliveModule | undefined =
  NativeModules.HermesKeepAlive;

/** 原生模块是否可用（Android 且已链接）。web/桌面/测试环境下为 false。 */
export const isAvailable = native != null;

/** API 33+ 通知运行时权限只请求一次（拒绝也照常启动，服务不依赖通知授权） */
let notificationPermissionRequested = false;

async function ensureNotificationPermission(): Promise<void> {
  if (notificationPermissionRequested) {
    return;
  }
  notificationPermissionRequested = true;
  if (Platform.OS !== 'android' || Platform.Version < 33) {
    return;
  }
  try {
    await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );
  } catch {
    // 拒绝/异常都不阻塞保活（FGS 不依赖通知授权，仅常驻通知不可见）
  }
}

/**
 * 启动前台保活（连接成功点调用——Android 12+ 禁止后台启动 FGS，前台是唯一
 * 合规时机）。重复调用仅刷新通知文案。
 */
export async function start(title: string, body: string): Promise<void> {
  if (!native) {
    return;
  }
  await ensureNotificationPermission();
  try {
    await native.start(title, body);
  } catch {
    // 保活失败不阻塞连接主流程（退回原有的断线重连兜底）
  }
}

/** 停止前台保活（手动断开连接时调用；重连周期内保持运行，不调 stop）。 */
export async function stop(): Promise<void> {
  if (!native) {
    return;
  }
  try {
    await native.stop();
  } catch {
    // ignore
  }
}
