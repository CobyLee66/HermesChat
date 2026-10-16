/**
 * queuedPromptsEngine.ts — 排队消息的排水引擎（订阅外部事件 → 在「观测空闲」
 * 时把队首一条送出去）。
 *
 * 排水契约（docs/protocol.md §2）：提交始终带 `prompt.submit {queued: true}`
 * ——服务端 `_handle_busy_submit`（tui_gateway/server.py）对该参数的语义是
 * 「客户端队列排水：只入队、绝不被打成 live-turn correction / interrupt」，
 * 因此即便「客户端观测空闲、服务端仍在收尾」也能保证排到当前轮之后。
 *
 * 排队条目按「会话跨重启身份」`{profile}:{持久化会话 id}` 存（queuedKeyFor），
 * 本引擎负责把 key 还原成「当前挂载的 live sid」再提交——见 liveSidFor。
 *
 * 为什么按「事件」而不是按「任意 store 变更」触发：排水失败会往时间线写错误
 * 红条（chat store 一次 set），若按任意变更重试就会立刻自激循环。这里的触发
 * 面收敛为外部事件：
 *   ① 连接 state → ready（断线期间不排水，重连即补发）；
 *   ② 某会话由「未知 / 忙」变为「已知且空闲」——覆盖进入会话（attach）、
 *      turn 结束（busy 翻转）、后台回前台重放（D057 闸门延后落 busy）；
 *   ③ 排队条目变化（覆盖「turn 刚结束、用户此刻才点排队」的竞态）；
 *   ④ 用户点中断后的 forceFlushQueued（跳过 busy 门，仅送队首一条）；
 *   ⑤ 引擎初始化。
 * 失败后仅保留队首、记一次节流时间戳，等下一个外部事件再试（不自激）。
 */

import {useChatStore} from './chat';
import {useConnectionStore} from './connection';
import {queuedKeyFor, useQueuedPromptsStore} from './queuedPrompts';
import {dlog} from '../utils/desktopLog';

/** 失败后的最小重试间隔（防同一事件簇内反复尝试） */
const MIN_RETRY_INTERVAL_MS = 1000;

/** 正在提交中的会话（防重入：同一会话同一时刻只允许一条在飞） */
const flushing = new Set<string>();
/** 各会话上次「尝试失败」时刻（成功即清除；失败按间隔节流） */
const failedAt = new Map<string, number>();
let unsubscribes: (() => void)[] = [];
let initialized = false;

/** 当前有排队条目、且会话已挂载的 key 列表（廉价早退用）。 */
function queuedKeys(): string[] {
  return Object.keys(useQueuedPromptsStore.getState().queues);
}

/**
 * 排队 key（`{profile}:{持久化会话 id}`）→ 当前可发送的 live sid。
 *
 * 排队 key 跨 live sid 稳定，所以每次排水都要把 key 还原到「现在挂载的这个
 * live sid」：先看 key 自身是否是挂载中的会话（storedSessionId 未知时的退化
 * 形态），再按 bySession 里的 storedSessionId 匹配；跳过迁移 shell / foreign
 * 只读视图 / 派生中的会话。
 */
function liveSidFor(key: string): string | null {
  const bySession = useChatStore.getState().bySession;
  const candidates: string[] = [];
  if (bySession[key]) {
    candidates.push(key);
  }
  for (const [sid, st] of Object.entries(bySession)) {
    if (sid !== key && queuedKeyFor(st.profile, sid, st.storedSessionId) === key) {
      candidates.push(sid);
    }
  }
  for (const sid of candidates) {
    const st = bySession[sid];
    if (st.migratedTo || st.foreign || st.forking) {
      continue;
    }
    return sid;
  }
  return null;
}

/**
 * 尝试送出某会话的队首一条。
 * force=true 跳过 busy 门（用户点中断后的补发；服务端 `queued` 语义保证安全），
 * 且不递归推进——剩余条目仍按「空闲翻转」逐条走。
 */
function pump(key: string, opts?: {force?: boolean}): void {
  if (flushing.has(key)) {
    return;
  }
  if (useConnectionStore.getState().state !== 'ready') {
    return;
  }
  const queue = useQueuedPromptsStore.getState().queues[key];
  if (!queue || queue.length === 0) {
    return;
  }
  const sid = liveSidFor(key);
  if (!sid) {
    return;
  }
  const st = useChatStore.getState().bySession[sid];
  if (!opts?.force && st.busy) {
    return;
  }
  const lastFailed = failedAt.get(key);
  if (lastFailed !== undefined && Date.now() - lastFailed < MIN_RETRY_INTERVAL_MS) {
    return;
  }
  const head = queue[0];
  flushing.add(key);
  // 微任务延迟：sendPrompt 会同步写 store（回显气泡 + snapshot），不能在
  // zustand 监听器的调用栈里嵌套 set
  Promise.resolve().then(async () => {
    let attempted = false;
    try {
      attempted = await useChatStore
        .getState()
        .sendPrompt(sid, head.text, {queued: true});
    } catch (e) {
      dlog(
        'WARN',
        `排队消息发送异常 ${sid.slice(0, 8)}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    flushing.delete(key);
    if (!attempted) {
      // 什么都没提交（自愈失败等）：条目留在队列里等下一个外部事件
      failedAt.set(key, Date.now());
      return;
    }
    failedAt.delete(key);
    // 出队：run 成功即视为本条已交付（失败时时间线已有错误红条，与手动发送
    // 同款 UX，不自动重发以免重复气泡）。removeQueued 会同步触发队列订阅 →
    // 那里已经会再 pump 一次（此时 flushing 已清），故这里只在非 force 时补一次
    useQueuedPromptsStore.getState().removeQueued(head.id);
    if (!opts?.force) {
      pump(key);
    }
  });
}

/** 对所有有排队的会话各试一次（幂等）。 */
function pumpAll(): void {
  for (const key of queuedKeys()) {
    pump(key);
  }
}

/** 中断后立即补发队首（跳过 busy 门；仅一条，剩余仍按空闲翻转逐条走）。 */
export function forceFlushQueued(liveSid: string): void {
  const st = useChatStore.getState().bySession[liveSid];
  pump(queuedKeyFor(st?.profile ?? '', liveSid, st?.storedSessionId), {
    force: true,
  });
}

/**
 * 装配排水引擎（App.tsx 启动时调用一次）。幂等：重复调用只保留一组订阅。
 */
export function initQueuedPromptsEngine(): void {
  if (initialized) {
    return;
  }
  initialized = true;
  unsubscribes = [
    useChatStore.subscribe((state, prev) => {
      const keys = queuedKeys();
      if (keys.length === 0) {
        return;
      }
      for (const key of keys) {
        const sid = liveSidFor(key);
        if (!sid) {
          continue;
        }
        const now = state.bySession[sid];
        if (!now || now.busy) {
          continue;
        }
        // 只在「未知 → 空闲」（attach）或「忙 → 空闲」（turn 结束）时动手；
        // prevBusy === false 说明这次 set 不是真正的空闲翻转（含排水失败自身
        // 写的错误条），跳过以避免自激重试
        if (prev.bySession[sid]?.busy === false) {
          continue;
        }
        pump(key);
      }
    }),
    useConnectionStore.subscribe((state, prev) => {
      if (state.state === 'ready' && prev.state !== 'ready') {
        pumpAll();
      }
    }),
    useQueuedPromptsStore.subscribe(() => {
      pumpAll();
    }),
  ];
  // 初始试探：启动时队列已恢复且连接已就绪的场景
  pumpAll();
}

/** 测试辅助：退订并清空引擎内部状态。 */
export function _resetQueuedPromptsEngineForTests() {
  for (const off of unsubscribes) {
    off();
  }
  unsubscribes = [];
  initialized = false;
  flushing.clear();
  failedAt.clear();
}
