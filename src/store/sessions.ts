/**
 * 会话列表 store：按 profile 分组的 session.list，新建/删除/恢复。
 */

import {create} from 'zustand';

import {getRpc} from '../rpc/runtime';
import type {
  SessionCreateResult,
  SessionListRow,
  SessionResumeResult,
} from '../rpc/types';

interface SessionsStore {
  /** profile name → 会话列表（按最近活跃排序，服务端已排） */
  byProfile: Record<string, SessionListRow[]>;
  loading: boolean;
  error: string | null;
  /** sessions.changed 广播后置脏，下次进入列表时刷新 */
  stale: boolean;

  markStale(): void;
  refresh(profile: string, force?: boolean): Promise<void>;
  create(profile: string, title?: string): Promise<SessionCreateResult>;
  resume(profile: string, sessionId: string): Promise<SessionResumeResult>;
  remove(profile: string, sessionId: string): Promise<boolean>;
}

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  byProfile: {},
  loading: false,
  error: null,
  stale: false,

  markStale() {
    set({stale: true});
  },

  async refresh(profile, force = false) {
    if (!force && !get().stale && get().byProfile[profile]) {
      return;
    }
    set({loading: true, error: null});
    try {
      const rpc = getRpc();
      const raw = await rpc.call<{sessions?: SessionListRow[]}>(
        'session.list',
        {profile, limit: 100},
      );
      const sessions = raw?.sessions ?? [];
      set(s => ({
        byProfile: {...s.byProfile, [profile]: sessions},
        loading: false,
        stale: false,
      }));
    } catch (e) {
      set({loading: false, error: e instanceof Error ? e.message : String(e)});
    }
  },

  async create(profile, title) {
    const rpc = getRpc();
    const result = await rpc.call<SessionCreateResult>('session.create', {
      profile,
      cols: 100,
      title: title ?? '',
    });
    set({stale: true});
    return result;
  },

  async resume(profile, sessionId) {
    const rpc = getRpc();
    return rpc.call<SessionResumeResult>('session.resume', {
      session_id: sessionId,
      profile,
      cols: 100,
    });
  },

  async remove(profile, sessionId) {
    const rpc = getRpc();
    try {
      await rpc.call('session.delete', {session_id: sessionId, profile});
    } catch (e) {
      // 4023: 活动会话不能删——先 close 再删
      const code = (e as {code?: number}).code;
      if (code === 4023) {
        await rpc.call('session.close', {session_id: sessionId});
        await rpc.call('session.delete', {session_id: sessionId, profile});
      } else {
        throw e;
      }
    }
    set(s => ({
      byProfile: {
        ...s.byProfile,
        [profile]: (s.byProfile[profile] ?? []).filter(r => r.id !== sessionId),
      },
    }));
    return true;
  },
}));
