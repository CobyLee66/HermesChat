/**
 * 聊天 store：每 session 的 TimelineItem[]、流式更新、审批卡状态。
 * 聚合器实例放模块级 Map（非响应式），zustand 里存快照引用驱动渲染。
 */

import {create} from 'zustand';

import {TimelineAggregator} from '../rpc/aggregator';
import {getRpc} from '../rpc/runtime';
import type {
  ApprovalChoice,
  ModelOptionsResult,
  ProjectedMessage,
  SessionInfoPayload,
  TimelineItem,
} from '../rpc/types';

export interface SessionChatState {
  items: TimelineItem[];
  /** 最近一次 status.update（状态条） */
  status: {kind: string; text: string} | null;
  info: SessionInfoPayload | null;
  /** turn 进行中（message.start ~ message.complete/error） */
  busy: boolean;
  /** 所属 profile（resume 需要） */
  profile: string;
  /** 持久化会话 id（session.resume 用它；live sid 可能变） */
  storedSessionId: string;
  /** 重连后 resume 失败标记（UI 提示重进） */
  resumeFailed?: boolean;
}

const EMPTY: SessionChatState = {
  items: [],
  status: null,
  info: null,
  busy: false,
  profile: '',
  storedSessionId: '',
};

const aggregators = new Map<string, TimelineAggregator>();

function aggFor(sid: string): TimelineAggregator {
  let agg = aggregators.get(sid);
  if (!agg) {
    agg = new TimelineAggregator();
    aggregators.set(sid, agg);
  }
  return agg;
}

interface ChatStore {
  bySession: Record<string, SessionChatState>;

  /** 进入会话：建聚合器 + 历史投影。重复进入不重建。 */
  attach(
    sid: string,
    opts?: {
      messages?: ProjectedMessage[];
      info?: SessionInfoPayload;
      profile?: string;
      storedSessionId?: string;
    },
  ): void;
  detach(sid: string): void;
  applyEvent(sid: string, type: string, payload: unknown): void;
  /** 重连 resume 成功：用服务端历史重建（live sid 变化时迁移 key）。 */
  reattachAfterResume(
    oldSid: string,
    liveSid: string,
    opts: {messages: ProjectedMessage[]; running?: boolean},
  ): void;
  /** resume 失败（服务端已回收）：标记，不清数据。 */
  markResumeFailed(sid: string): void;
  sendPrompt(sid: string, text: string): Promise<void>;
  interrupt(sid: string): Promise<void>;
  respondApproval(
    sid: string,
    requestId: string,
    choice: ApprovalChoice,
  ): Promise<void>;
  switchModel(sid: string, model: string, provider?: string): Promise<string>;
  fetchModelOptions(sid?: string): Promise<ModelOptionsResult>;
}

export const useChatStore = create<ChatStore>((set, get) => {
  function snapshot(sid: string, patch?: Partial<SessionChatState>) {
    const agg = aggFor(sid);
    const prev = get().bySession[sid] ?? EMPTY;
    set(s => ({
      bySession: {
        ...s.bySession,
        [sid]: {
          ...prev,
          items: agg.getItems(),
          status: agg.lastStatus,
          busy: agg.isStreaming(),
          ...patch,
        },
      },
    }));
  }

  return {
    bySession: {},

    attach(sid, opts) {
      const agg = aggFor(sid);
      if (opts?.messages && agg.getItems().length === 0) {
        agg.hydrate(opts.messages);
      }
      snapshot(sid, {
        ...(opts?.info ? {info: opts.info} : null),
        ...(opts?.profile !== undefined ? {profile: opts.profile} : null),
        ...(opts?.storedSessionId !== undefined
          ? {storedSessionId: opts.storedSessionId}
          : null),
        resumeFailed: false,
      });
    },

    reattachAfterResume(oldSid, liveSid, opts) {
      const prev = get().bySession[oldSid];
      const agg = new TimelineAggregator();
      agg.hydrate(opts.messages ?? []);
      if (liveSid !== oldSid) {
        aggregators.delete(oldSid);
        set(s => {
          const next = {...s.bySession};
          delete next[oldSid];
          return {bySession: next};
        });
      }
      aggregators.set(liveSid, agg);
      set(s => ({
        bySession: {
          ...s.bySession,
          [liveSid]: {
            ...(prev ?? EMPTY),
            items: agg.getItems(),
            status: null,
            busy: opts.running ?? false,
            resumeFailed: false,
          },
        },
      }));
    },

    markResumeFailed(sid) {
      set(s => ({
        bySession: {
          ...s.bySession,
          [sid]: {...(s.bySession[sid] ?? EMPTY), resumeFailed: true, busy: false},
        },
      }));
    },

    detach(sid) {
      aggregators.delete(sid);
      set(s => {
        const next = {...s.bySession};
        delete next[sid];
        return {bySession: next};
      });
    },

    applyEvent(sid, type, payload) {
      if (type === 'session.info') {
        const prev = get().bySession[sid] ?? EMPTY;
        const info = payload as SessionInfoPayload;
        set(s => ({
          bySession: {
            ...s.bySession,
            [sid]: {
              ...prev,
              info,
              busy: typeof info.running === 'boolean' ? info.running : prev.busy,
            },
          },
        }));
        return;
      }
      if (type === 'session.reclaimed') {
        set(s => ({
          bySession: {
            ...s.bySession,
            [sid]: {...(s.bySession[sid] ?? EMPTY), busy: false},
          },
        }));
        return;
      }
      const handled = aggFor(sid).applyEvent(type, payload);
      if (handled) {
        snapshot(sid);
      }
    },

    async sendPrompt(sid, text) {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      const agg = aggFor(sid);
      agg.appendUserMessage(trimmed);
      snapshot(sid, {busy: true});
      try {
        await getRpc().call('prompt.submit', {session_id: sid, text: trimmed});
      } catch (e) {
        agg.applyEvent('error', {
          message: `发送失败: ${e instanceof Error ? e.message : String(e)}`,
        });
        snapshot(sid, {busy: false});
      }
    },

    async interrupt(sid) {
      try {
        await getRpc().call('session.interrupt', {session_id: sid});
      } catch (e) {
        aggFor(sid).applyEvent('error', {
          message: `中断失败: ${e instanceof Error ? e.message : String(e)}`,
        });
        snapshot(sid);
      }
    },

    async respondApproval(sid, requestId, choice) {
      const agg = aggFor(sid);
      // 乐观更新：卡片立即标记/消失
      agg.resolveApproval(requestId, choice);
      snapshot(sid);
      try {
        await getRpc().call('approval.respond', {
          session_id: sid,
          request_id: requestId,
          choice,
        });
      } catch (e) {
        agg.applyEvent('error', {
          message: `审批应答失败: ${e instanceof Error ? e.message : String(e)}`,
        });
        snapshot(sid);
      }
    },

    async switchModel(sid, model, provider) {
      const value = provider ? `${model} --provider ${provider}` : model;
      const result = await getRpc().call<{warning?: string; value?: string}>(
        'config.set',
        {key: 'model', value, session_id: sid},
      );
      return result?.warning ?? '';
    },

    async fetchModelOptions(sid) {
      return getRpc().call<ModelOptionsResult>(
        'model.options',
        sid ? {session_id: sid} : undefined,
      );
    },
  };
});

/** 测试辅助：清空全部聚合器。 */
export function _resetChatAggregators() {
  aggregators.clear();
}
