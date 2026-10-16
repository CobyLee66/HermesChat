/**
 * drafts.ts — 聊天输入框草稿（按「会话跨重启身份」存，AsyncStorage 持久化）。
 *
 * 背景：输入框原先是 useChatComposer 里的组件内 useState，以下路径都会清零——
 * 重连 resume 后 live sid 变化触发 migratedTo → navigation.replace 重建页面、
 * 返回列表再进、切后台进程被杀。草稿因此提升为独立 store：
 * - 不放 chat store 的 bySession：attach/reattachAfterResume 的投影重建会整体
 *   覆盖该 key（这正是原丢失根因之一），独立 store 天然免疫；
 * - key 用 `{profile}:{持久化会话 id}`（`sessionIdentityFor`）而**不是 live sid**
 *   （2026-10-17 修订）：live sid 在 WS 断开超宽限被孤儿回收/闲置 TTL/网关重启
 *   后会换，用 live sid 当 key 时「App 退出 → 重进会话」读的是另一个 key，
 *   草稿等于丢了（D060 的复验路径③「杀进程重启后草稿仍在」因此只在 resume
 *   恰好复用同一 live sid 时成立、是假阳性）。持久化身份全程不变，无需随迁；
 *   只有「会话重建」（自愈时新建库行，持久身份真的变了）才调 migrateDraft 搬 key；
 * - 持久化整表防抖 300ms 落盘，AppState 进后台立即 flush（覆盖「切后台后
 *   被杀进程」）；LRU 上限 200 条防无限膨胀。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {AppState} from 'react-native';
import {create} from 'zustand';

const STORAGE_KEY = 'hermes.drafts.v1';
/** 草稿条数上限（超出按最近触碰淘汰最旧） */
const MAX_ENTRIES = 200;
const PERSIST_DEBOUNCE_MS = 300;

interface DraftsStore {
  /** 归属 key（见 `sessionIdentityFor`）→ 草稿文本 */
  drafts: Record<string, string>;
  /** 写草稿；空串 = 清除该 key（表内不留空条目） */
  setDraft(key: string, text: string): void;
  /**
   * 会话身份迁移（仅「会话重建」这类持久身份真的变了的场景）：旧 key 的非空
   * 草稿搬到新 key（覆盖新 key 残留），旧 key 删除。换 live sid 不需要调用。
   */
  migrateDraft(oldKey: string, newKey: string): void;
  /**
   * 删除会话等场景批量清理：候选 id（live sid / 持久化 id）里任一命中
   * `{profile}:{id}` 形态的 key 即删（清理是粗粒度操作，宁可多删不可残留）。
   */
  pruneDrafts(profile: string, ids: string[]): void;
  /** 启动时恢复（App.tsx 初始化调用） */
  loadPersisted(): Promise<void>;
}

/** 各 key 最近触碰时间（LRU 淘汰依据；不入盘，启动恢复时按键序种子化） */
const lastTouched = new Map<string, number>();
let touchSeq = 0;

function touch(sid: string) {
  lastTouched.set(sid, ++touchSeq);
}

function evictIfNeeded(drafts: Record<string, string>): Record<string, string> {
  const keys = Object.keys(drafts);
  if (keys.length <= MAX_ENTRIES) {
    return drafts;
  }
  const sorted = [...keys].sort(
    (a, b) => (lastTouched.get(a) ?? 0) - (lastTouched.get(b) ?? 0),
  );
  const next = {...drafts};
  for (const k of sorted.slice(0, keys.length - MAX_ENTRIES)) {
    delete next[k];
    lastTouched.delete(k);
  }
  return next;
}

// ─── 持久化（防抖 + 后台立即 flush） ───────────────────────────
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

function persistNow() {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!dirty) {
    return;
  }
  dirty = false;
  AsyncStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(useDraftStore.getState().drafts),
  ).catch(() => {});
}

function schedulePersist() {
  dirty = true;
  if (persistTimer !== null) {
    return;
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, PERSIST_DEBOUNCE_MS);
}

// 切后台/被划走前落盘（进程被杀后的最后防线）
AppState.addEventListener('change', s => {
  if (s !== 'active') {
    persistNow();
  }
});

export const useDraftStore = create<DraftsStore>((set, get) => ({
  drafts: {},

  setDraft(key, text) {
    touch(key);
    const prev = get().drafts;
    const next = {...prev};
    if (text === '') {
      if (!(key in next)) {
        return;
      }
      delete next[key];
    } else {
      next[key] = text;
    }
    set({drafts: evictIfNeeded(next)});
    schedulePersist();
  },

  migrateDraft(oldKey, newKey) {
    if (oldKey === newKey) {
      return;
    }
    const text = get().drafts[oldKey];
    if (!text) {
      return;
    }
    touch(newKey);
    const next = {...get().drafts, [newKey]: text};
    delete next[oldKey];
    lastTouched.delete(oldKey);
    set({drafts: evictIfNeeded(next)});
    schedulePersist();
  },

  pruneDrafts(profile, ids) {
    const prev = get().drafts;
    const prefix = `${profile || '-'}:`;
    const hit = Object.keys(prev).filter(
      k => k.startsWith(prefix) && ids.includes(k.slice(prefix.length)),
    );
    if (hit.length === 0) {
      return;
    }
    const next = {...prev};
    for (const k of hit) {
      delete next[k];
      lastTouched.delete(k);
    }
    set({drafts: next});
    schedulePersist();
  },

  async loadPersisted() {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return;
      }
      const v: unknown = JSON.parse(raw);
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        return;
      }
      const drafts: Record<string, string> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === 'string' && val !== '') {
          drafts[k] = val;
          touch(k);
        }
      }
      set({drafts: evictIfNeeded(drafts)});
    } catch {
      // 损坏数据视为空（下次写入覆盖）
    }
  },
}));

/** 测试辅助：复位 store、LRU 与持久化定时器。 */
export function _resetDraftsForTests() {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  dirty = false;
  lastTouched.clear();
  touchSeq = 0;
  useDraftStore.setState({drafts: {}});
}

/** 测试辅助：立即触发一次落盘（跳过防抖等待）。 */
export function _flushDraftsForTests() {
  persistNow();
}
