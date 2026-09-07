/**
 * desktopLog — 渲染层诊断日志。
 * 有桌面桥时经 IPC 写入主进程 userData/logs/main.log（与主进程日志同一文件、
 * 同一时间线，便于对齐「空白发生时刻」前后主进程与渲染层各自的事件）；
 * 无桥（浏览器/移动端/Jest）时不发 IPC，测试环境完全静默，其余回落 console。
 */

import {getDesktopBridge} from '../ssh/desktopHermesSsh';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

const MAX_LEN = 4000;

export function dlog(level: LogLevel, msg: string): void {
  const text = msg.slice(0, MAX_LEN);
  const bridge = getDesktopBridge();
  if (bridge) {
    bridge.log(level, text).catch(() => {
      // 日志通道失败静默
    });
    return;
  }
  // Jest 下完全静默，避免污染测试输出（process 经断言访问，浏览器端为 undefined）
  const nodeEnv = (globalThis as {process?: {env?: {NODE_ENV?: string}}}).process
    ?.env?.NODE_ENV;
  if (nodeEnv === 'test') {
    return;
  }
  (level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log)(
    `[HermesChat] ${text}`,
  );
}
