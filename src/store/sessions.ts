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
import AsyncStorage from '@react-native-async-storage/async-storage';

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
import {
  SESSION_SORT_STORAGE_KEY,
  isSessionSortMode,
  type SessionSortMode,
} from '../utils/sessionSort';
import {useChatStore} from './chat';
import {useProfilesStore} from './profiles';

interface SessionsStore {
  /**
   * profile name → 会话列表（最近活跃序：服务端 last_active 降序 + 跨库
   * 交错，见 projectProfileSessions；「创建时间」排序档由 UI 侧派生）。
   */
  byProfile: Record<string, SessionListRow[]>;
  loading: boolean;
  error: string | null;
  /** sessions.changed 广播后置脏，下次进入列表时刷新 */
  stale: boolean;
  /** multiplex 归属映射（null = 待构建；EMPTY = 已降级） */
  nsMap: NamespaceMap | null;
  /** 会话列表排序档位（持久化，三端共用） */
  sortMode: SessionSortMode;

  markStale(): void;
  /**
   * 本地已知的标题变化：把各 profile 列表里该会话行就地替换（不重新拉列表）。
   * 行不在任何已加载列表里时置脏，下次进入列表再拉。
   */
  patchTitle(sessionId: string, title: string): void;
  refresh(profile: string, force?: boolean): Promise<void>;
  /** 构建（或复用）sessionId → 归属 profile 映射；exec 不可用 → 空映射。 */
  ensureNamespaceMap(force?: boolean): Promise<NamespaceMap>;
  /** 切换排序档位并持久化（失败静默——纯 UI 偏好） */
  setSortMode(mode: SessionSortMode): void;
  /** 启动时恢复持久化的排序档位（App.tsx 调一次，避免列表首帧闪默认档） */
  loadSortModePreference(): Promise<void>;
  create(profile: string, title?: string): Promise<SessionCreateResult>;
  resume(profile: string, sessionId: string): Promise<SessionResumeResult>;
  /**
   * 删除会话。sessionId 接受持久化 id（列表行）或 live sid（聊天菜单删除
   * 当前打开的会话）——内部按 chat store 归一化：delete/4023 判定用持久化
   * id，session.close 用 live sid（网关内存表只认它）。
   */
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
  sortMode: 'recent',

  markStale() {
    // 会话有变动：归属映射一并失效（新建/删除/改名都可能改变分布）
    set({stale: true, nsMap: null});
  },

  patchTitle(sessionId, title) {
    const {byProfile} = get();
    const next: Record<string, SessionListRow[]> = {};
    let found = false;
    let changed = false;
    for (const [profile, rows] of Object.entries(byProfile)) {
      const hit = rows.find(r => r.id === sessionId);
      if (!hit) {
        next[profile] = rows;
        continue;
      }
      found = true;
      if (hit.title === title) {
        // 值没变：保持原数组引用（选择器稳定性约定，避免无谓重渲染）
        next[profile] = rows;
        continue;
      }
      next[profile] = rows.map(r => (r.id === sessionId ? {...r, title} : r));
      changed = true;
    }
    if (changed) {
      set({byProfile: next});
    } else if (!found) {
      // 行不在任何已加载列表里：置脏，下次进入列表再拉
      get().markStale();
    }
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

  setSortMode(mode) {
    set({sortMode: mode});
    AsyncStorage.setItem(SESSION_SORT_STORAGE_KEY, mode).catch(() => {
      // 纯 UI 偏好，持久化失败静默
    });
  },

  async loadSortModePreference() {
    try {
      const raw = await AsyncStorage.getItem(SESSION_SORT_STORAGE_KEY);
      if (isSessionSortMode(raw)) {
        set({sortMode: raw});
      }
    } catch {
      // 读不到就用默认档
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
    // id 归一化（服务端语义，见 docs/protocol.md §2）：
    // - session.delete 的活动判定（4023）与查库都用持久化 id（session_key），
    //   传 live sid 一律 4007；
    // - session.close 直查网关内存 _sessions，只认 live sid，传持久化 id
    //   静默 closed:false（这正是旧 4023 恢复路径从未生效的原因）。
    const bySession = useChatStore.getState().bySession;
    const liveState = bySession[sessionId];
    let storedId = sessionId;
    let liveSid: string | undefined;
    if (liveState) {
      // 传进来的是 live sid（聊天菜单删除当前会话）
      liveSid = sessionId;
      storedId = liveState.storedSessionId || sessionId;
    } else {
      // 传进来的是持久化 id（列表长按/右键删除）；若该会话恰在本连接
      // 挂载（活动会话），反查 live sid 供 close 用
      liveSid = Object.keys(bySession).find(
        k => bySession[k].storedSessionId === sessionId,
      );
    }
    // namespaced 行物理在宿主 profile 的 state.db（multiplex 大库），删除必须
    // 落宿主库：按显示 profile 传参会去该 profile 自己的库找 → 4007 not found
    // （名义 profile 列表里的 qqbot 会话删不掉的根因）。本地过滤仍按显示列表。
    const row = (get().byProfile[profile] ?? []).find(r => r.id === storedId);
    const dbProfile =
      row?.namespaced && row.hostProfile ? row.hostProfile : profile;
    try {
      await rpc.call('session.delete', {session_id: storedId, profile: dbProfile});
    } catch (e) {
      // 4023: 活动会话不能删——先 close（live sid）再删（持久化 id）
      const code = (e as {code?: number}).code;
      if (code === 4023) {
        if (liveSid) {
          await rpc.call('session.close', {session_id: liveSid});
        }
        await rpc.call('session.delete', {
          session_id: storedId,
          profile: dbProfile,
        });
      } else {
        throw e;
      }
    }
    set(s => ({
      byProfile: {
        ...s.byProfile,
        [profile]: (s.byProfile[profile] ?? []).filter(r => r.id !== storedId),
      },
    }));
    return true;
  },
}));
