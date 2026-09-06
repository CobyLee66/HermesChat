/**
 * useCompleteNotifications — 窗口失焦时，任一会话回合完成弹系统通知。
 * 点击通知由主进程聚焦窗口。订阅 chat store 的 busy 翻转（true→false）。
 */

import {useEffect, useRef} from 'react';

import {useChatStore} from '../store/chat';
import {desktopNotify} from './desktopMedia';

export function useCompleteNotifications(enabled: boolean): void {
  const prevBusyRef = useRef<Map<string, boolean>>(new Map());

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const prevMap = prevBusyRef.current;
    const check = () => {
      const hidden = (globalThis as {document?: {hidden?: boolean}}).document
        ?.hidden;
      const bySession = useChatStore.getState().bySession;
      for (const [sid, st] of Object.entries(bySession)) {
        const prev = prevMap.get(sid) ?? false;
        const now = st.busy ?? false;
        if (prev && !now && hidden) {
          desktopNotify('Hermes', '会话回复已完成');
        }
        prevMap.set(sid, now);
      }
    };
    const unsub = useChatStore.subscribe(check);
    return () => {
      unsub();
      prevMap.clear();
    };
  }, [enabled]);
}
