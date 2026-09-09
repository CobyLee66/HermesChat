/**
 * cron store — 定时任务列表与控制动作（dashboard REST /api/cron/*）。
 *
 * 事件接线：jobs.json 变化时服务端广播 WS 事件 cron.changed（无 payload），
 * 这里按 RPC 实例自接线（连接重建换新 RpcClient 即重订阅；不进 connection.ts
 * 是为了避免 connection ↔ cron 循环导入——cron 的 REST 参数取自 connection store）。
 * 仅在本会话加载过列表后才响应事件（没开过定时任务视图不白发请求）。
 */

import {create} from 'zustand';

import {
  CronHttpError,
  deleteCronJob,
  listCronJobs,
  pauseCronJob,
  resumeCronJob,
  triggerCronJob,
} from '../rpc/cron';
import {getRpc} from '../rpc/runtime';
import type {RpcClient} from '../rpc/client';
import type {CronJob} from '../rpc/types';
import {useConnectionStore} from './connection';

const CHANGE_DEBOUNCE_MS = 1000;

interface CronStore {
  jobs: CronJob[];
  loading: boolean;
  error: string | null;
  /** 本会话是否已成功加载过（cron.changed 仅在加载过后续刷） */
  loaded: boolean;
  /** profile 筛选：'all' 或 profile name（放 store：切换视图不丢） */
  profileFilter: string;
  /** 行级忙碌（暂停/恢复/删除请求进行中） */
  busyJobIds: Record<string, boolean>;
  /** 立即运行进行中的 job id（同步长操作，行内转圈） */
  triggeringJobId: string | null;
  /**
   * silent=true：后台静默刷新（cron.changed / 动作后），不闪下拉 spinner，
   * 失败保用现值；列表为空时才落 error（首屏加载仍走非 silent）。
   */
  refresh(opts?: {silent?: boolean}): Promise<void>;
  setProfileFilter(filter: string): void;
  pause(job: CronJob): Promise<void>;
  resume(job: CronJob): Promise<void>;
  /** 同步跑完整个 job 才返回；409=已在运行（调用方按 CronHttpError 分支提示） */
  trigger(job: CronJob): Promise<void>;
  remove(job: CronJob): Promise<void>;
}

/** REST 参数（httpUrl/token 取自连接 store）；未连接直接抛错。 */
function connArgs(): {httpUrl: string; token: string} {
  const {httpUrl, token} = useConnectionStore.getState();
  if (!httpUrl) {
    throw new Error('未连接到 gateway');
  }
  return {httpUrl, token};
}

// ─── cron.changed 事件接线（模块级，见文件头注释） ──────────────

let wiredRpc: RpcClient | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function ensureEventsWired(rpc: RpcClient): void {
  if (wiredRpc === rpc) {
    return;
  }
  wiredRpc = rpc;
  rpc.on('cron.changed', () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (useCronStore.getState().loaded) {
        void useCronStore.getState().refresh({silent: true});
      }
    }, CHANGE_DEBOUNCE_MS);
  });
}

/** 测试专用：清模块级接线状态（_resetChatAggregators 同款约定）。 */
export function _resetCronEventWiring(): void {
  wiredRpc = null;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

export const useCronStore = create<CronStore>((set, get) => ({
  jobs: [],
  loading: false,
  error: null,
  loaded: false,
  profileFilter: 'all',
  busyJobIds: {},
  triggeringJobId: null,

  async refresh(opts) {
    const silent = opts?.silent ?? false;
    if (!silent) {
      set({loading: true, error: null});
    }
    try {
      const rpc = getRpc();
      ensureEventsWired(rpc);
      const {httpUrl, token} = connArgs();
      const jobs = await listCronJobs(httpUrl, token);
      set({jobs, loading: false, loaded: true});
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (silent) {
        // 后台刷新失败不打断列表；列表为空才暴露错误（空态有重试入口）
        if (get().jobs.length === 0) {
          set({error: message});
        }
      } else {
        set({loading: false, error: message});
      }
    }
  },

  setProfileFilter(profileFilter) {
    set({profileFilter});
  },

  async pause(job) {
    set(s => ({busyJobIds: {...s.busyJobIds, [job.id]: true}}));
    try {
      const {httpUrl, token} = connArgs();
      await pauseCronJob(httpUrl, token, job.id, job.profile);
      await get().refresh({silent: true});
    } finally {
      set(s => {
        const busyJobIds = {...s.busyJobIds};
        delete busyJobIds[job.id];
        return {busyJobIds};
      });
    }
  },

  async resume(job) {
    set(s => ({busyJobIds: {...s.busyJobIds, [job.id]: true}}));
    try {
      const {httpUrl, token} = connArgs();
      await resumeCronJob(httpUrl, token, job.id, job.profile);
      await get().refresh({silent: true});
    } finally {
      set(s => {
        const busyJobIds = {...s.busyJobIds};
        delete busyJobIds[job.id];
        return {busyJobIds};
      });
    }
  },

  async trigger(job) {
    set({triggeringJobId: job.id});
    try {
      const {httpUrl, token} = connArgs();
      await triggerCronJob(httpUrl, token, job.id, job.profile);
      await get().refresh({silent: true});
    } finally {
      set({triggeringJobId: null});
    }
  },

  async remove(job) {
    set(s => ({busyJobIds: {...s.busyJobIds, [job.id]: true}}));
    try {
      const {httpUrl, token} = connArgs();
      await deleteCronJob(httpUrl, token, job.id, job.profile);
      await get().refresh({silent: true});
    } finally {
      set(s => {
        const busyJobIds = {...s.busyJobIds};
        delete busyJobIds[job.id];
        return {busyJobIds};
      });
    }
  },
}));

/** 409 = 任务正在运行（trigger 并发触发）。 */
export function isCronConflict(e: unknown): boolean {
  return e instanceof CronHttpError && e.status === 409;
}
