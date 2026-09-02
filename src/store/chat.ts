/**
 * 聊天 store：每 session 的 TimelineItem[]、流式更新、审批卡状态。
 * 聚合器实例放模块级 Map（非响应式），zustand 里存快照引用驱动渲染。
 */

import {create} from 'zustand';

import {TimelineAggregator} from '../rpc/aggregator';
import {getRpc} from '../rpc/runtime';
import type {
  ApprovalChoice,
  FileAttachResult,
  ImageAttachResult,
  ModelOptionsResult,
  ProjectedMessage,
  SessionCreateResult,
  SessionInfoPayload,
  SessionResumeResult,
  TimelineItem,
} from '../rpc/types';
import {getExecRemote} from '../ssh/execRemote';
import {fetchRemoteHistory, toSeedMessages} from '../ssh/remoteHistory';
import {getFork, setFork} from './forkMap';
import {useProfilesStore} from './profiles';
import {useSessionsStore} from './sessions';
import {prepareImageForUpload, readFileAsDataUrl} from '../utils/media';

/** 已 attach 到 session、待下一条 prompt 带上的图片。 */
export interface PendingAttachment {
  /** gateway 侧绝对路径（image.attach_bytes 返回） */
  path: string;
  /** 压缩产物的本地 file:// URI（待发横条预览） */
  localUri: string;
  name: string;
}

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
  /**
   * foreign 只读视图：multiplex 大库里归属本 profile、但物理在其它库的会话。
   * 不 resume（避免错人格 agent），历史经 SSH exec 只读 sqlite 展示；
   * 首次发送时派生（session.create parent_session_id）到当前 profile。
   */
  foreign?: {originId: string; hostProfile: string} | null;
  /** 派生进行中（fork-on-send） */
  forking?: boolean;
  /** 已派生迁移：本 key 的会话已迁到新的 own 会话 sid（UI 据此换路由） */
  migratedTo?: string;
  /** 待发送图片（已上传到 gateway，随下一条 prompt 进上下文） */
  pendingAttachments: PendingAttachment[];
}

const EMPTY: SessionChatState = {
  items: [],
  status: null,
  info: null,
  busy: false,
  profile: '',
  storedSessionId: '',
  foreign: null,
  pendingAttachments: [],
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
      /** foreign 只读视图标记（own 会话不传/传 null） */
      foreign?: {originId: string; hostProfile: string} | null;
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
  /**
   * foreign 会话的首次发送：forkMap 命中 → resume 派生会话；否则
   * 只读 sqlite 取全量历史 → session.create(parent_session_id) 派生 →
   * attach 切到派生会话 → prompt.submit。旧 key 标记 migratedTo。
   */
  forkForeignAndSend(sid: string, trimmed: string): Promise<void>;
  interrupt(sid: string): Promise<void>;
  /**
   * 选图 → 压缩（长边 2048 JPEG 80）→ image.attach_bytes 逐张上传 → 进待发横条。
   * 单张失败在时间线记错误条，不影响其余。
   */
  attachImages(
    sid: string,
    picks: {uri: string; name?: string | null}[],
  ): Promise<void>;
  /** 从待发横条移除（同时 image.detach 从 session 队列里摘除）。 */
  removeAttachment(sid: string, path: string): Promise<void>;
  /** 文件上传（file.attach），返回追加到输入框的 @file: 引用文本。 */
  attachFile(
    sid: string,
    file: {uri: string; name?: string | null; mimeType?: string | null},
  ): Promise<string>;
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
        // attach = 重新进入会话：foreign 标记以本次传入为准（own 会话清除）
        foreign: opts?.foreign ?? null,
        forking: false,
        migratedTo: undefined,
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
      const pending =
        get().bySession[sid]?.pendingAttachments ?? EMPTY.pendingAttachments;
      // 有待发图片时允许空文本（服务端会补 "What do you see in this image?"）
      if (!trimmed && pending.length === 0) {
        return;
      }
      // foreign 只读会话：首次发送先派生到当前 profile，再在派生会话里发
      if (get().bySession[sid]?.foreign) {
        await get().forkForeignAndSend(sid, trimmed);
        return;
      }
      const agg = aggFor(sid);
      agg.appendUserMessage(
        trimmed,
        pending.map(a => ({path: a.path})),
      );
      // 发送即清空待发横条；若 submit 失败图片仍排在服务端队列里，
      // 会随下一条 prompt 进上下文（时间线里有错误条提示）。
      snapshot(sid, {busy: true, pendingAttachments: []});
      try {
        await getRpc().call('prompt.submit', {session_id: sid, text: trimmed});
      } catch (e) {
        agg.applyEvent('error', {
          message: `发送失败: ${e instanceof Error ? e.message : String(e)}`,
        });
        snapshot(sid, {busy: false});
      }
    },

    async forkForeignAndSend(sid, trimmed) {
      const st = get().bySession[sid];
      const foreign = st?.foreign;
      if (!foreign || st?.forking || !trimmed) {
        return;
      }
      const profile = st?.profile ?? '';
      if (!profile) {
        return;
      }
      const rpc = getRpc();
      snapshot(sid, {forking: true});
      try {
        let liveSid: string;
        let storedId: string;
        let messages: ProjectedMessage[];
        let info: SessionInfoPayload | undefined;
        const existingFork = await getFork(foreign.originId, profile);
        if (existingFork) {
          // 之前已派生过（如派生后 App 重启再来）：直接 resume fork，走正常人格
          const r = await rpc.call<SessionResumeResult>('session.resume', {
            session_id: existingFork.forkId,
            profile,
            cols: 100,
          });
          liveSid = r.session_id;
          storedId = r.stored_session_id ?? existingFork.forkId;
          messages = r.messages ?? [];
          info = r.info;
        } else {
          // session.history RPC 只认 live sid（持久化 id 实测 4001）→
          // 经 SSH exec 只读 sqlite 取全量历史做种子
          const exec = getExecRemote();
          const hostPath = useProfilesStore
            .getState()
            .list.find(p => p.name === foreign.hostProfile)?.path;
          if (!exec || !hostPath) {
            throw new Error('需要 SSH 连接才能读取该会话的历史');
          }
          const history = await fetchRemoteHistory(
            exec,
            `${hostPath}/state.db`,
            foreign.originId,
          );
          const created = await rpc.call<SessionCreateResult>(
            'session.create',
            {
              profile,
              parent_session_id: foreign.originId,
              messages: toSeedMessages(history),
              cols: 100,
              title: '',
            },
          );
          storedId = created.stored_session_id ?? created.session_id;
          await setFork(foreign.originId, profile, storedId);
          liveSid = created.session_id;
          messages = created.messages ?? [];
          info = created.info;
        }
        // 派生会话挂正常 chat 状态；旧 key 标记迁移（ChatScreen 换路由过去）
        get().attach(liveSid, {
          messages,
          info,
          profile,
          storedSessionId: storedId,
        });
        set(s => ({
          bySession: {
            ...s.bySession,
            [sid]: {
              ...(s.bySession[sid] ?? EMPTY),
              forking: false,
              migratedTo: liveSid,
            },
          },
        }));
        // 会话列表出现新 fork（sessions.changed 也会触发，双保险）
        useSessionsStore.getState().markStale();
        // 在派生会话里发出这条
        const agg = aggFor(liveSid);
        agg.appendUserMessage(trimmed);
        snapshot(liveSid, {busy: true});
        try {
          await rpc.call('prompt.submit', {session_id: liveSid, text: trimmed});
        } catch (e) {
          agg.applyEvent('error', {
            message: `发送失败: ${e instanceof Error ? e.message : String(e)}`,
          });
          snapshot(liveSid, {busy: false});
        }
      } catch (e) {
        aggFor(sid).applyEvent('error', {
          message: `派生到当前 profile 失败: ${e instanceof Error ? e.message : String(e)}`,
        });
        snapshot(sid, {forking: false});
      }
    },

    async attachImages(sid, picks) {
      const rpc = getRpc();
      for (const p of picks) {
        try {
          const prep = await prepareImageForUpload(p.uri, p.name);
          const res = await rpc.call<ImageAttachResult>('image.attach_bytes', {
            session_id: sid,
            content_base64: prep.base64,
            filename: prep.filename,
          });
          const item: PendingAttachment = {
            path: res.path,
            localUri: prep.localUri,
            name: res.name ?? prep.filename,
          };
          set(s => {
            const prev = s.bySession[sid] ?? EMPTY;
            return {
              bySession: {
                ...s.bySession,
                [sid]: {
                  ...prev,
                  pendingAttachments: [...prev.pendingAttachments, item],
                },
              },
            };
          });
        } catch (e) {
          aggFor(sid).applyEvent('error', {
            message: `图片上传失败: ${e instanceof Error ? e.message : String(e)}`,
          });
          snapshot(sid);
        }
      }
    },

    async removeAttachment(sid, path) {
      set(s => {
        const prev = s.bySession[sid] ?? EMPTY;
        return {
          bySession: {
            ...s.bySession,
            [sid]: {
              ...prev,
              pendingAttachments: prev.pendingAttachments.filter(
                a => a.path !== path,
              ),
            },
          },
        };
      });
      try {
        await getRpc().call('image.detach', {session_id: sid, path});
      } catch (e) {
        aggFor(sid).applyEvent('error', {
          message: `移除图片失败: ${e instanceof Error ? e.message : String(e)}`,
        });
        snapshot(sid);
      }
    },

    async attachFile(sid, file) {
      const dataUrl = await readFileAsDataUrl(file.uri, file.mimeType);
      const res = await getRpc().call<FileAttachResult>('file.attach', {
        session_id: sid,
        data_url: dataUrl,
        name: file.name ?? '',
      });
      return res.ref_text ?? '';
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
