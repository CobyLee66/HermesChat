/**
 * 会话列表 store：按 profile 分组的 session.list，新建/删除/恢复。
 *
 * multiplex 归属分组（见 src/ssh/namespaceMap.ts）：启用 multiplex_profiles 时
 * qqbot 等会话物理写在宿主 profile（本机为 main）的 state.db，`session.list`
 * 不含 session_key，无法分辨归属。这里经 SSH exec 只读 sqlite 构建
 * sessionId → 归属 映射（nsMap），refresh 时：
 * - 非宿主 profile：own（自己库的会话）+ 从宿主库列表过滤出归属本 profile
 *   的行（标记 namespaced/hostProfile），合并去重；
 * - 宿主 profile：own 里排除归属其他现存 profile 的行（它们已挪到各自
 *   profile 下显示）；
 * - exec 不可用（web 直连/无 sqlite3）时映射为空，行为 = 现状（全部在宿主下）。
 */

import {create} from 'zustand';

import {getRpc} from '../rpc/runtime';
import type {
  SessionCreateResult,
  SessionListRow,
  SessionResumeResult,
} from '../rpc/types';
import {getExecRemote} from '../ssh/execRemote';
import {
  EMPTY_NAMESPACE_MAP,
  fetchNamespaceMap,
  foreignHostsOf,
  projectProfileSessions,
  type NamespaceMap,
} from '../ssh/namespaceMap';
import {useProfilesStore} from './profiles';

interface SessionsStore {
  /** profile name → 会话列表（按最近活跃排序） */
  byProfile: Record<string, SessionListRow[]>;
  loading: boolean;
  error: string | null;
  /** sessions.changed 广播后置脏，下次进入列表时刷新 */
  stale: boolean;
  /** multiplex 归属映射（null = 待构建；EMPTY = 已降级） */
  nsMap: NamespaceMap | null;

  markStale(): void;
  refresh(profile: string, force?: boolean): Promise<void>;
  /** 构建（或复用）sessionId → 归属 profile 映射；exec 不可用 → 空映射。 */
  ensureNamespaceMap(force?: boolean): Promise<NamespaceMap>;
  create(profile: string, title?: string): Promise<SessionCreateResult>;
  resume(profile: string, sessionId: string): Promise<SessionResumeResult>;
  remove(profile: string, sessionId: string): Promise<boolean>;
}

/** 同一次构建只跑一条 exec（并发 refresh 去重）。 */
let nsMapInflight: Promise<NamespaceMap> | null = null;

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  byProfile: {},
  loading: false,
  error: null,
  stale: false,
  nsMap: null,

  markStale() {
    // 会话有变动：归属映射一并失效（新建/删除/改名都可能改变分布）
    set({stale: true, nsMap: null});
  },

  async ensureNamespaceMap(force = false) {
    const cached = get().nsMap;
    if (!force && cached) {
      return cached;
    }
    if (nsMapInflight) {
      return nsMapInflight;
    }
    const p = (async (): Promise<NamespaceMap> => {
      try {
        const exec = getExecRemote();
        const profiles = useProfilesStore.getState().list;
        const map =
          exec && profiles.length > 0
            ? await fetchNamespaceMap(exec, profiles)
            : EMPTY_NAMESPACE_MAP;
        set({nsMap: map});
        return map;
      } catch {
        // 静默降级：映射为空 → 行为 = 现状
        set({nsMap: EMPTY_NAMESPACE_MAP});
        return EMPTY_NAMESPACE_MAP;
      }
    })();
    // 注意：先赋值再在 finally 按身份清理。IIFE 同步完成时（exec 为 null
    // 的降级路径）其内部 finally 会早于赋值执行，在那里清理会把 promise
    // 泄漏给后续调用（已踩坑：web 降级后映射永远不再重建）
    nsMapInflight = p;
    try {
      return await p;
    } finally {
      if (nsMapInflight === p) {
        nsMapInflight = null;
      }
    }
  },

  async refresh(profile, force = false) {
    if (!force && !get().stale && get().byProfile[profile]) {
      return;
    }
    set({loading: true, error: null});
    try {
      const rpc = getRpc();
      const map = await get().ensureNamespaceMap(force);
      const ownRaw = await rpc.call<{sessions?: SessionListRow[]}>(
        'session.list',
        {profile, limit: 100},
      );
      const own = ownRaw?.sessions ?? [];

      // foreign 行：归属本 profile 但物理在其它库（multiplex 大库），
      // 逐个宿主拉列表再按映射过滤；单个宿主拉取失败跳过，不影响整体
      const foreign: SessionListRow[] = [];
      for (const host of foreignHostsOf(map, profile, profile)) {
        try {
          const raw = await rpc.call<{sessions?: SessionListRow[]}>(
            'session.list',
            {profile: host, limit: 100},
          );
          for (const r of raw?.sessions ?? []) {
            const e = map.byId[r.id];
            if (e && e.namespace === profile && e.host === host) {
              foreign.push({...r, namespaced: true, hostProfile: host});
            }
          }
        } catch {
          // 宿主列表拉取失败：该批 foreign 行本轮不显示
        }
      }

      const knownProfiles = new Set(
        useProfilesStore.getState().list.map(p => p.name),
      );
      knownProfiles.add(profile);
      const sessions = projectProfileSessions({
        own,
        foreign,
        map,
        profile,
        knownProfiles,
      });
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
