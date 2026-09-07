/**
 * HermesChat 桌面壳 preload。
 *
 * 通过 contextBridge 暴露 window.hermesDesktop，方法面与
 * docs/ssh-module.md §2 的 HermesSsh 契约同构（connect/exec/startCommand/
 * stopCommand/openLocalForward/closeLocalForward/disconnect + onStdout/
 * onExit/onDisconnect 事件订阅，订阅返回取消函数）。
 * 渲染层 src/ssh/desktopHermesSsh.ts 据此提供与 Android 原生模块一致的消费面。
 */

import {contextBridge, ipcRenderer, type IpcRendererEvent} from 'electron';

interface SshEventPayload {
  kind: 'stdout' | 'exit' | 'disconnect';
  taskId?: string;
  line?: string;
  exitCode?: number;
  reason?: string;
}

function subscribe(
  kind: SshEventPayload['kind'],
  matchTaskId: string | null,
  cb: (payload: SshEventPayload) => void,
): () => void {
  const handler = (_e: IpcRendererEvent, data: SshEventPayload) => {
    if (data.kind !== kind) {
      return;
    }
    if (matchTaskId != null && data.taskId !== matchTaskId) {
      return;
    }
    cb(data);
  };
  ipcRenderer.on('ssh:event', handler);
  return () => {
    ipcRenderer.removeListener('ssh:event', handler);
  };
}

contextBridge.exposeInMainWorld('hermesDesktop', {
  connect: (config: unknown) => ipcRenderer.invoke('ssh:connect', config),
  exec: (command: string, timeoutMs: number) =>
    ipcRenderer.invoke('ssh:exec', command, timeoutMs),
  startCommand: (command: string) =>
    ipcRenderer.invoke('ssh:startCommand', command),
  stopCommand: (taskId: string) => ipcRenderer.invoke('ssh:stopCommand', taskId),
  openLocalForward: (remotePort: number) =>
    ipcRenderer.invoke('ssh:openLocalForward', remotePort),
  closeLocalForward: (localPort: number) =>
    ipcRenderer.invoke('ssh:closeLocalForward', localPort),
  disconnect: () => ipcRenderer.invoke('ssh:disconnect'),

  onStdout: (taskId: string, cb: (line: string) => void): (() => void) =>
    subscribe('stdout', taskId, p => cb(p.line ?? '')),
  onExit: (taskId: string, cb: (exitCode: number) => void): (() => void) =>
    subscribe('exit', taskId, p => cb(p.exitCode ?? -1)),
  onDisconnect: (cb: (reason: string) => void): (() => void) =>
    subscribe('disconnect', null, p => cb(p.reason ?? '')),

  // 桌面能力：文件选择 / 读文件 / 系统通知
  pickFiles: (opts: {images: boolean; multiple: boolean}) =>
    ipcRenderer.invoke('desktop:pickFiles', opts),
  readFileDataUrl: (filePath: string) =>
    ipcRenderer.invoke('desktop:readFileDataUrl', filePath),
  readFileText: (filePath: string) =>
    ipcRenderer.invoke('desktop:readFileText', filePath),
  notify: (payload: {title: string; body: string}) =>
    ipcRenderer.invoke('desktop:notify', payload),

  // 诊断日志：写入主进程 userData/logs/main.log
  log: (level: string, msg: string) =>
    ipcRenderer.invoke('desktop:log', level, msg),
});
