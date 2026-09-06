/**
 * dialogStore — 桌面/web 自绘确认框与提示框的排队状态。
 * utils/alert.ts 在桌面桥存在时把 confirm/alert 路由到这里（RNW 的
 * Alert.alert 无 UI、window.alert 观感差），由 DesktopApp 根部挂 Host 渲染。
 */

import {create} from 'zustand';

export interface PendingDialog {
  kind: 'confirm' | 'alert';
  title: string;
  message: string;
  resolve: (ok: boolean) => void;
}

interface DialogState {
  /** 队列只显示第一条（聊天类 App 确认框低频，不做堆叠） */
  current: PendingDialog | null;
  open: (dialog: PendingDialog) => void;
  settle: (ok: boolean) => void;
}

export const useDialogStore = create<DialogState>(set => ({
  current: null,
  open: dialog => set({current: dialog}),
  settle: ok => {
    const {current} = useDialogStore.getState();
    current?.resolve(ok);
    set({current: null});
  },
}));

/** 队列一个确认框（resolve true=确认）。 */
export function enqueueConfirm(
  title: string,
  message: string,
): Promise<boolean> {
  return new Promise(resolve => {
    useDialogStore.getState().open({kind: 'confirm', title, message, resolve});
  });
}

/** 队列一个提示框（仅「知道了」）。 */
export function enqueueAlert(title: string, message: string): Promise<void> {
  return new Promise(resolve => {
    useDialogStore
      .getState()
      .open({kind: 'alert', title, message, resolve: () => resolve()});
  });
}
