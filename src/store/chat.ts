/**
 * 聊天 store：每 session 的 TimelineItem[]、流式更新、审批卡状态。
 * 聚合器实例放模块级 Map（非响应式），zustand 里存快照引用驱动渲染。
 */

import {create} from 'zustand';

import {TimelineAggregator, type InflightSnapshot} from '../rpc/aggregator';
import {getRpc} from '../rpc/runtime';
import {executeSlash, looksLikeSlashCommand} from '../rpc/slash';
import type {
  ApprovalChoice,
  ApprovalRequestPayload,
  ClarifyRequestPayload,
  FileAttachResult,
  ImageAttachResult,
  ModelOptionsResult,
  ProjectedMessage,
  SessionCreateResult,
  SessionInfoPayload,
  SessionResumeResult,
  TimelineItem,
  UsageInfo,
} from '../rpc/types';
import {getExecRemote} from '../ssh/execRemote';
import {fetchRemoteHistory, toSeedMessages} from '../ssh/remoteHistory';
import {dlog} from '../utils/desktopLog';
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
  /** 最近一次 thinking.delta 占位（busy 指示器文本，空串已清除时为 null） */
  thinkingHint: string | null;
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
  thinkingHint: null,
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

/** resume 挂起的审批/澄清补进时间线（走正常事件路径，自带 request_id 去重）。 */
function applyPending(
  agg: TimelineAggregator,
  approvals?: ApprovalRequestPayload[],
  clarifies?: ClarifyRequestPayload[],
) {
  for (const p of approvals ?? []) {
    agg.applyEvent('approval.request', p);
  }
  for (const p of clarifies ?? []) {
    agg.applyEvent('clarify.request', p);
  }
}

/** 历史投影按 role 计数（诊断：重进后工具卡缺失时先看 tool 行到没到）。 */
function countRoles(messages: ProjectedMessage[]): string {
  const c = {user: 0, assistant: 0, tool: 0, other: 0};
  for (const m of messages) {
    if (m?.role === 'user' || m?.role === 'assistant' || m?.role === 'tool') {
      c[m.role] += 1;
    } else {
      c.other += 1;
    }
  }
  return `user=${c.user} assistant=${c.assistant} tool=${c.tool} other=${c.other}`;
}

interface ChatStore {
  bySession: Record<string, SessionChatState>;

  /** 进入会话：建聚合器 + 历史投影；重进时以服务端消息为准重建。 */
  attach(
    sid: string,
    opts?: {
      messages?: ProjectedMessage[];
      info?: SessionInfoPayload;
      profile?: string;
      storedSessionId?: string;
      /** foreign 只读视图标记（own 会话不传/传 null） */
      foreign?: {originId: string; hostProfile: string} | null;
      /** resume 返回的挂起审批（事件单播给旧 transport，靠它补卡） */
      pendingApprovals?: ApprovalRequestPayload[];
      /** resume 返回的挂起澄清提问 */
      pendingClarifies?: ClarifyRequestPayload[];
      /** resume 结果的 running（turn 进行中） */
      running?: boolean;
      /** resume 结果的 turn 进行中快照（部分流出的助手文本等） */
      inflight?: InflightSnapshot | null;
    },
  ): void;
  detach(sid: string): void;
  applyEvent(sid: string, type: string, payload: unknown): void;
  /** 重连 resume 成功：用服务端历史重建（live sid 变化时迁移 key）。 */
  reattachAfterResume(
    oldSid: string,
    liveSid: string,
    opts: {
      messages: ProjectedMessage[];
      running?: boolean;
      inflight?: InflightSnapshot | null;
      pendingApprovals?: ApprovalRequestPayload[];
      pendingClarifies?: ClarifyRequestPayload[];
    },
  ): void;
  /** resume 失败（服务端已回收）：标记，不清数据。 */
  markResumeFailed(sid: string): void;
  sendPrompt(sid: string, text: string): Promise<void>;
  /**
   * 斜杠命令执行（dashboard 同款客户端流水线）：slash.exec 主通道，
   * 失败回退 command.dispatch（skill/send 型转 prompt.submit）。
   * 命令回显/输出走系统灰条，不产生用户气泡。
   */
  sendSlashCommand(sid: string, command: string): Promise<void>;
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
  /** 澄清提问作答；questionId 仅批量问题需要（服务端按 qid 归答案）。 */
  respondClarify(
    sid: string,
    requestId: string,
    answer: string,
    questionId?: string,
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
          thinkingHint: agg.lastThinkingHint,
          busy: agg.isStreaming(),
          ...patch,
        },
      },
    }));
  }

  /** 普通 prompt 提交的公共尾部：用户气泡回显 + prompt.submit + 失败红条。 */
  async function submitPlain(
    sid: string,
    text: string,
    images: {path: string}[] = [],
    clearAttachments = false,
  ) {
    const agg = aggFor(sid);
    agg.appendUserMessage(text, images);
    // 发送即清空待发横条；若 submit 失败图片仍排在服务端队列里，
    // 会随下一条 prompt 进上下文（时间线里有错误条提示）。
    snapshot(
      sid,
      clearAttachments ? {busy: true, pendingAttachments: []} : {busy: true},
    );
    try {
      await getRpc().call('prompt.submit', {session_id: sid, text});
    } catch (e) {
      agg.applyEvent('error', {
        message: `发送失败: ${e instanceof Error ? e.message : String(e)}`,
      });
      snapshot(sid, {busy: false});
    }
  }

  return {
    bySession: {},

    attach(sid, opts) {
      const agg = aggFor(sid);
      if (opts?.messages) {
        dlog(
          'INFO',
          `attach ${sid.slice(0, 8)}：历史 ${opts.messages.length} 条（${countRoles(opts.messages)}）`,
        );
        // 进入/重进会话：服务端历史是权威快照，始终重建时间线。
        // 此前只在聚合器为空时 hydrate——resume 快路径返回同一 live sid，
        // 重进就永远停在首次进入时的旧快照（其它端/断线期间的新消息全丢）。
        // 若重进时本地恰有流式尾部（同一 turn），恢复时保留它的结构块。
        const previousStreaming = agg.takeStreamingTail();
        agg.hydrate(opts.messages);
        agg.restoreLiveTail(opts.running === true, opts.inflight, previousStreaming);
      }
      applyPending(agg, opts?.pendingApprovals, opts?.pendingClarifies);
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
        ...(opts?.running !== undefined ? {busy: opts.running} : null),
      });
    },

    reattachAfterResume(oldSid, liveSid, opts) {
      const prev = get().bySession[oldSid];
      const oldAgg = aggregators.get(oldSid) ?? null;
      dlog(
        'INFO',
        `reattach ${oldSid.slice(0, 8)}→${liveSid.slice(0, 8)}：历史 ${opts.messages?.length ?? 0} 条（${countRoles(opts.messages ?? [])}）`,
      );
      // 断线前若有流式尾部，恢复时尽量保留（同 turn 前缀扩展判断）
      const previousStreaming = oldAgg ? oldAgg.takeStreamingTail() : null;
      const agg = new TimelineAggregator();
      agg.hydrate(opts.messages ?? []);
      agg.restoreLiveTail(opts.running === true, opts.inflight, previousStreaming);
      applyPending(agg, opts.pendingApprovals, opts.pendingClarifies);
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
            thinkingHint: null,
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
      // session.usage（turn 中每秒增量）与 message.complete 都带 usage：
      // 合并进 info，会话信息弹层才能显示实时 token 用量/上下文窗口。
      // 注：usage 是 gateway 进程内计数器，resume 历史会话后从 0 重计。
      if (type === 'session.usage' || type === 'message.complete') {
        const usage = (payload as {usage?: UsageInfo} | null)?.usage;
        if (usage) {
          const prev = get().bySession[sid] ?? EMPTY;
          set(s => ({
            bySession: {
              ...s.bySession,
              [sid]: {
                ...prev,
                info: {...(prev.info ?? {}), usage},
              },
            },
          }));
        }
        if (type === 'session.usage') {
          return;
        }
      }
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
      const agg = aggFor(sid);
      const handled = agg.applyEvent(type, payload);
      if (handled) {
        snapshot(sid);
      }
      // 重进 mid-turn 会话时尾部是 inflight 纯文本投影（本轮工具卡/思考块
      // 缺失）；turn 结束后历史投影已含结构（tool 行/reasoning），重拉重建。
      if (type === 'message.complete' && agg.takeNeedsHistoryRefresh()) {
        getRpc()
          .call<{messages?: ProjectedMessage[]}>('session.history', {
            session_id: sid,
          })
          .then(r => {
            // 竞态：下一 turn 已开始（流式中）则让位，结构等下次 attach 重建
            if (agg.isStreaming()) {
              return;
            }
            agg.hydrate(r.messages ?? []);
            snapshot(sid, {busy: false});
          })
          .catch(e => {
            dlog(
              'WARN',
              `message.complete 后重拉历史失败 ${sid.slice(0, 8)}: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          });
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
      // 斜杠命令分流：prompt.submit 不拦截 "/" 文本（会当普通消息直达模型），
      // 走 dashboard 同款客户端执行流水线；命令不是消息，不回显气泡、不动待发横条。
      if (looksLikeSlashCommand(trimmed)) {
        await get().sendSlashCommand(sid, trimmed);
        return;
      }
      await submitPlain(
        sid,
        trimmed,
        pending.map(a => ({path: a.path})),
        true,
      );
    },

    async sendSlashCommand(sid, command) {
      const agg = aggFor(sid);
      agg.appendSystemMessage(command);
      snapshot(sid, {});
      await executeSlash({
        command,
        sessionId: sid,
        call: (method, params) => getRpc().call(method, params),
        callbacks: {
          sys: t => {
            agg.appendSystemMessage(t);
            snapshot(sid, {});
          },
          // skill/send 型指令的最终落点仍是普通 prompt；此处不再做斜杠
          // 判断——dispatch 下发的 message 恰以 / 开头时会无限递归。
          send: msg => submitPlain(sid, msg),
        },
      });
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
        let pendingApprovals: ApprovalRequestPayload[] | undefined;
        let pendingClarifies: ClarifyRequestPayload[] | undefined;
        let running: boolean | undefined;
        let inflight: InflightSnapshot | null | undefined;
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
          pendingApprovals = r.pending_approval;
          pendingClarifies = r.pending_clarify;
          running = r.running;
          inflight = r.inflight;
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
          pendingApprovals,
          pendingClarifies,
          running,
          inflight,
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
        // 在派生会话里发出这条（斜杠命令同样分流到执行流水线）
        if (looksLikeSlashCommand(trimmed)) {
          await get().sendSlashCommand(liveSid, trimmed);
        } else {
          await submitPlain(liveSid, trimmed);
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

    async respondClarify(sid, requestId, answer, questionId) {
      const agg = aggFor(sid);
      // 乐观更新：该问题立即标记已答
      agg.resolveClarify(requestId, questionId ?? '');
      snapshot(sid);
      try {
        // clarify.respond 走全局 pending 注册表，不需要 session_id
        await getRpc().call('clarify.respond', {
          request_id: requestId,
          answer,
          ...(questionId ? {question_id: questionId} : null),
        });
      } catch (e) {
        agg.applyEvent('error', {
          message: `作答失败: ${e instanceof Error ? e.message : String(e)}`,
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
