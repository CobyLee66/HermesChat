/**
 * queuedPrompts.ts — busy（AI 输出中）期间的排队消息（按「会话跨重启身份」存，
 * AsyncStorage 持久化）。
 *
 * 背景：AI 还在输出时用户敲的下一条消息，以前只能等——按发送键要么被
 * 服务端当「忙态提交」（可能打断/改写当前轮），要么只能自己盯着等结束。
 * 排队方案：本地先把消息收进这个独立 store，等「当前流程结束」（busy 翻转）
 * 或用户点中断时由引擎逐条送出（见 queuedPromptsEngine.ts）。
 *
 * 为什么是独立 store（同 drafts 的取舍，D060/D064）：
 * - 不放 chat store 的 bySession：attach/reattachAfterResume 的投影重建会整体
 *   覆盖该 key，排队内容会被历史投影冲掉；
 * - 不放聚合器时间线：重进会话即按服务端历史重建，本地投影同样不保；
 * - 持久化整表防抖 300ms 落盘，AppState 进后台立即 flush（覆盖「切后台后
 *   被杀进程」）；LRU 上限 200 个会话防无限膨胀，单会话上限 20 条。
 *
 * key 用 `{profile}:{持久化会话 id}`（queuedKeyFor）而不是 live sid：后者在
 * 断线回收/网关重启后会换，App 退出重进就再也认不回旧队列（详见 queuedKeyFor）。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {AppState} from 'react-native';
import {create} from 'zustand';

const STORAGE_KEY = 'hermes.queuedPrompts.v1';
/** 会话条数上限（超出按最近触碰淘汰最旧） */
const MAX_SESSIONS = 200;
/** 单会话排队条数上限（超出拒绝入队，调用方提示用户） */
const MAX_PER_SESSION = 20;
const PERSIST_DEBOUNCE_MS = 300;

/** 一条排队消息（仅文本：附件仍留在待发横条，随下一次真实提交进上下文）。 */
export interface QueuedPrompt {
  id: string;
  text: string;
  createdAt: number;
}

/**
 * 排队 key = 会话的**跨重启身份**：`{profile}:{持久化会话 id}`。
 *
 * 为什么不用 live sid：live sid 是易逝的（WS 断开超宽限被孤儿回收、闲置 TTL、
 * LRU 淘汰、网关进程退出都会换一个新的），而排队内容必须跨「App 退出 → 重进
 * 会话」存活——用 live sid 做 key，重进后就再也认不回旧队列（既不显示也不补发）。
 * 带上 profile 是防 multiplex 场景下两个 profile 库里恰好同 id 的会话串队
 * （串队的后果是把消息发进错的会话，不只是显示问题）。
 * storedSessionId 未知时退回 live sid（退化，但不会误串会话）。
 */
export function queuedKeyFor(
  profile: string,
  liveSid: string,
  storedId?: string | null,
): string {
  return `${profile || '-'}:${storedId || liveSid}`;
}

interface QueuedPromptsStore {
  /** 排队 key（见 queuedKeyFor）→ FIFO 队列 */
  queues: Record<string, QueuedPrompt[]>;
  /** 入队（尾部）。空文本或超出单会话上限返回 false（调用方提示，不改 state） */
  enqueue(key: string, text: string): boolean;
  /**
   * 按 id 出队（全表扫描）。不按 key 找：提交过程中会话身份可能变化
   * （自愈 resume / foreign 派生 / 会话重建），条目未必还在原 key 下。
   */
  removeQueued(id: string): void;
  /** 会话身份迁移：旧 key 的队列并到新 key 尾部（覆盖新 key 残留），旧 key 删除 */
  migrateQueue(oldKey: string, newKey: string): void;
  /**
   * 删除会话等场景批量清理：候选 id（live sid / 持久化 id）里任一命中
   * `{profile}:{id}` 形态的 key 即删（清理是粗粒度操作，宁可多删不可残留）。
   */
  pruneQueues(profile: string, ids: string[]): void;
  /** 启动时恢复（App.tsx 初始化调用） */
  loadPersisted(): Promise<void>;
}

/** 各会话最近触碰时间（LRU 淘汰依据；不入盘，启动恢复时按键序种子化） */
const lastTouched = new Map<string, number>();
let touchSeq = 0;
/** 队列条目 id 自增段（与时间戳组合，进程内唯一） */
let idSeq = 0;

function touch(sid: string) {
  lastTouched.set(sid, ++touchSeq);
}
function evictIfNeeded(
  queues: Record<string, QueuedPrompt[]>,
): Record<string, QueuedPrompt[]> {
  const keys = Object.keys(queues);
  if (keys.length <= MAX_SESSIONS) {
    return queues;
  }
  const sorted = [...keys].sort(
    (a, b) => (lastTouched.get(a) ?? 0) - (lastTouched.get(b) ?? 0),
  );
  const next = {...queues};
  for (const k of sorted.slice(0, keys.length - MAX_SESSIONS)) {
    delete next[k];
    lastTouched.delete(k);
  }
  return next;
}

/** 解析一条持久化条目：形状不符返回 null（损坏数据容忍，不炸启动） */
function parseEntry(raw: unknown): QueuedPrompt | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const text = typeof o.text === 'string' ? o.text.trim() : '';
  if (!text) {
    return null;
  }
  return {
    id: typeof o.id === 'string' && o.id ? o.id : `q_load_${++idSeq}`,
    text,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now(),
  };
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
    JSON.stringify(useQueuedPromptsStore.getState().queues),
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

export const useQueuedPromptsStore = create<QueuedPromptsStore>((set, get) => ({
  queues: {},

  enqueue(key, text) {
    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }
    touch(key);
    const prev = get().queues;
    const list = prev[key] ?? [];
    if (list.length >= MAX_PER_SESSION) {
      return false;
    }
    const next = {
      ...prev,
      [key]: [
        ...list,
        {id: `q_${Date.now()}_${++idSeq}`, text: trimmed, createdAt: Date.now()},
      ],
    };
    set({queues: evictIfNeeded(next)});
    schedulePersist();
    return true;
  },

  removeQueued(id) {
    const prev = get().queues;
    let hit = false;
    const next: Record<string, QueuedPrompt[]> = {};
    for (const [key, list] of Object.entries(prev)) {
      const kept = list.filter(it => it.id !== id);
      if (kept.length !== list.length) {
        hit = true;
      }
      if (kept.length > 0) {
        next[key] = kept;
      }
    }
    if (!hit) {
      return;
    }
    set({queues: next});
    schedulePersist();
  },

  migrateQueue(oldKey, newKey) {
    if (oldKey === newKey) {
      return;
    }
    const prev = get().queues;
    const moved = prev[oldKey];
    if (!moved || moved.length === 0) {
      return;
    }
    touch(newKey);
    const next = {...prev};
    delete next[oldKey];
    lastTouched.delete(oldKey);
    const kept = (prev[newKey] ?? []).filter(
      it => !moved.some(m => m.id === it.id),
    );
    next[newKey] = [...kept, ...moved];
    set({queues: evictIfNeeded(next)});
    schedulePersist();
  },

  pruneQueues(profile, ids) {
    const prev = get().queues;
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
    set({queues: next});
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
      const queues: Record<string, QueuedPrompt[]> = {};
      for (const [key, list] of Object.entries(v as Record<string, unknown>)) {
        if (!Array.isArray(list)) {
          continue;
        }
        const parsed = list
          .map(parseEntry)
          .filter((it): it is QueuedPrompt => it !== null)
          .slice(0, MAX_PER_SESSION);
        if (parsed.length > 0) {
          queues[key] = parsed;
          touch(key);
        }
      }
      set({queues: evictIfNeeded(queues)});
    } catch {
      // 损坏数据视为空（下次写入覆盖）
    }
  },
}));

/** 测试辅助：复位 store、LRU 与持久化定时器。 */
export function _resetQueuedPromptsForTests() {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  dirty = false;
  lastTouched.clear();
  touchSeq = 0;
  idSeq = 0;
  useQueuedPromptsStore.setState({queues: {}});
}

/** 测试辅助：立即触发一次落盘（跳过防抖等待）。 */
export function _flushQueuedPromptsForTests() {
  persistNow();
}
