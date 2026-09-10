/**
 * desktopUiStore — 桌面壳的界面选中态（不进导航栈，纯壳内状态）。
 *
 * 壳的选中 profile / 打开的会话 / narrow 单列当前面 / Profile 编辑弹层。
 * 业务数据仍在 sessions/chat/profiles store，这里只记「壳当前显示什么」。
 */

import {create} from 'zustand';

import type {CronRunRow} from '../rpc/types';

export interface DesktopChatRef {
  sessionId: string;
  profile: string;
  title: string;
}

interface DesktopUiState {
  selectedProfile: string | null;
  chat: DesktopChatRef | null;
  /** narrow 单列下当前面：会话列表或聊天 */
  narrowPane: 'sessions' | 'chat';
  /** Profile 编辑弹层（值为 profile name；null 关闭） */
  profileEditOpen: string | null;
  /** 定时任务编辑弹层（jobId 空 = 新建；null 关闭） */
  cronEditOpen: {jobId?: string; profile?: string} | null;
  /** 定时任务运行历史弹层（null 关闭） */
  cronRunsOpen: {jobId: string; name: string; profile?: string} | null;
  /** 定时任务运行详情弹层（叠在运行历史上层；null 关闭） */
  cronRunDetailOpen: {run: CronRunRow; name?: string; profile?: string} | null;
  /** 主页首屏视图（Profile 列表 / 定时任务） */
  homeView: 'sessions' | 'cron';
  selectProfile: (profile: string | null) => void;
  openChat: (chat: DesktopChatRef) => void;
  closeChat: () => void;
  setNarrowPane: (pane: 'sessions' | 'chat') => void;
  setProfileEditOpen: (profile: string | null) => void;
  setCronEditOpen: (open: {jobId?: string; profile?: string} | null) => void;
  setCronRunsOpen: (
    open: {jobId: string; name: string; profile?: string} | null,
  ) => void;
  setCronRunDetailOpen: (
    open: {run: CronRunRow; name?: string; profile?: string} | null,
  ) => void;
  setHomeView: (view: 'sessions' | 'cron') => void;
  /** 断线清空（连接重建后壳重新选择） */
  reset: () => void;
}

export const useDesktopUiStore = create<DesktopUiState>(set => ({
  selectedProfile: null,
  chat: null,
  narrowPane: 'sessions',
  profileEditOpen: null,
  cronEditOpen: null,
  cronRunsOpen: null,
  cronRunDetailOpen: null,
  homeView: 'sessions',
  selectProfile: profile =>
    set(state =>
      state.selectedProfile === profile
        ? state
        : // 切 profile 即清聊天选择（会话列表随 profile 变化，旧选择不再成立）
          {selectedProfile: profile, chat: null, narrowPane: 'sessions'},
    ),
  openChat: chat => set({chat, narrowPane: 'chat'}),
  closeChat: () => set({chat: null, narrowPane: 'sessions'}),
  setNarrowPane: narrowPane => set({narrowPane}),
  setProfileEditOpen: profileEditOpen => set({profileEditOpen}),
  setCronEditOpen: cronEditOpen => set({cronEditOpen}),
  setCronRunsOpen: cronRunsOpen => set({cronRunsOpen}),
  setCronRunDetailOpen: cronRunDetailOpen => set({cronRunDetailOpen}),
  setHomeView: homeView => set({homeView}),
  reset: () =>
    set({
      selectedProfile: null,
      chat: null,
      narrowPane: 'sessions',
      profileEditOpen: null,
      cronEditOpen: null,
      cronRunsOpen: null,
      cronRunDetailOpen: null,
      homeView: 'sessions',
    }),
}));

/** 模块级便捷入口：打开会话列（非 React 上下文也能用）。 */
export function openChat(chat: DesktopChatRef): void {
  useDesktopUiStore.getState().openChat(chat);
}
