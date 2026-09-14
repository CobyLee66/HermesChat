/**
 * 聊天 store：每 session 的 TimelineItem[]、流式更新、审批卡状态。
 * 聚合器实例放模块级 Map（非响应式），zustand 里存快照引用驱动渲染。
 */

import {create} from 'zustand';

import {TimelineAggregator, type InflightSnapshot} from '../rpc/aggregator';
import {getRpc} from '../rpc/runtime';
import {executeSlash, looksLikeSlashCommand, parseSlash} from '../rpc/slash';
import {t} from '../i18n';
import type {
  ApprovalChoice,
  ApprovalRequestPayload,
  ClarifyRequestPayload,
  FileAttachResult,
  ImageAttachResult,
  ModelOptionsResult,
  OneOrMany,
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
  /**
   * 会话标题（本地已知的最新值）。undefined = 未知（头部回退到路由参数）。
   * 来源：attach 种子 / session.title 事件（首轮自动命名）/ session.info
   * 事件 / /title 命令后主动读回（见 refreshTitle）。
   */
  title?: string;
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

/**
 * resume 挂起交互归一化为数组：服务端 `pending_approval` / `pending_clarify`
 * 是**单个对象**（dict）而非列表。直接 `for...of` 一个 plain object 会抛
 * TypeError——Android Hermes 的报错文案正是
 * 「iterator method is not callable」（表现为「打开会话失败」），
 * 2026-09-11 clarify 挂起期间打不开会话即此因。
 */
function asPendingList<T>(v: OneOrMany<T> | undefined | null): T[] {
  if (!v) {
    return [];
  }
  return Array.isArray(v) ? v : [v];
}

/** resume 挂起的审批/澄清补进时间线（走正常事件路径，自带 request_id 去重）。 */
function applyPending(
  agg: TimelineAggregator,
  approvals?: OneOrMany<ApprovalRequestPayload>,
  clarifies?: OneOrMany<ClarifyRequestPayload>,
) {
  for (const p of asPendingList(approvals)) {
    agg.applyEvent('approval.request', p);
  }
  for (const p of asPendingList(clarifies)) {
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
      /** 标题种子（会话列表行/新建会话标题）；缺省保留本地已有值 */
      title?: string;
      /** resume 返回的挂起审批（事件单播给旧 transport，靠它补卡） */
      pendingApprovals?: OneOrMany<ApprovalRequestPayload>;
      /** resume 返回的挂起澄清提问 */
      pendingClarifies?: OneOrMany<ClarifyRequestPayload>;
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
      /** resume 返回的 info（重连后刷新模型/思考等级；usage 缺失时靠 syncSessionInfo 读回） */
      info?: SessionInfoPayload;
      running?: boolean;
      inflight?: InflightSnapshot | null;
      pendingApprovals?: OneOrMany<ApprovalRequestPayload>;
      pendingClarifies?: OneOrMany<ClarifyRequestPayload>;
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
   * 读回权威标题：`session.title` RPC 只读形式（不带 title 参数，服务端返回
   * 库中 sanitize 后的值），同时刷新本会话头部与会话列表行。
   * /title 命令执行后调用——该命令由服务端 slash worker 写库，**不推任何
   * 事件**（见 docs/protocol.md §2），只能主动读回。
   */
  refreshTitle(sid: string): Promise<void>;
  /**
   * 主动同步会话上下文信息：`session.usage` RPC 只读形式（与 session.usage
   * 事件 / message.complete 同源口径，返回 model + context_used/max/percent）。
   * 重进会话后调用——resume 返回的 info 普遍缺 usage（计数器是 gateway 进程
   * 内状态，见 docs/protocol.md §3），不主动读回则顶栏「上下文用量」要等新
   * 消息输出才出现。只认 live sid（持久化 id 一律 4001），须在 resume 之后调。
   */
  syncSessionInfo(sid: string): Promise<void>;
  /**
   * 重命名会话：`session.title` RPC 写形式（对齐官方 desktop 的 rename 路径，
   * 优先 RPC 而非 slash 命令——结果结构化、无需读回），成功后本地落地标题
   * （头部 + 会话列表行）；sanitize 被拒（4022 等）时抛错由调用方提示。
   */
  renameSession(sid: string, title: string): Promise<void>;
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
        message: t('chat.sendFailed', {
          message: e instanceof Error ? e.message : String(e),
        }),
      });
      snapshot(sid, {busy: false});
    }
  }

  /**
   * 标题落地：更新本会话头部 + 会话列表行。空标题忽略（服务端可能还没
   * 落库，用 "" 覆盖会把已有标题抹掉）。storedId 缺省用本地记录的持久化 id；
   * 本地没有该会话状态（未打开）时只回填列表行，不建幽灵状态。
   */
  function applyTitle(sid: string, rawTitle: unknown, storedId?: string) {
    const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
    if (!title) {
      return;
    }
    const prev = get().bySession[sid];
    if (prev && prev.title !== title) {
      set(s => ({
        bySession: {
          ...s.bySession,
          [sid]: {...(s.bySession[sid] ?? EMPTY), title},
        },
      }));
    }
    const rowId = storedId || prev?.storedSessionId;
    if (rowId) {
      useSessionsStore.getState().patchTitle(rowId, title);
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
        // 标题种子只在非空时覆盖：重进时列表行可能还是旧值，不能把
        // 已读回的新标题降级（空串保留本地已有标题）
        ...(opts?.title ? {title: opts.title} : null),
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
            // resume 返回的 info（模型/思考等级可能已变）：有则整体替换，
            // usage 缺口由调用方随后的 syncSessionInfo 读回补齐
            ...(opts.info ? {info: opts.info} : null),
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
        // session.info 也带 title（服务端 _session_info）——改名 RPC/首轮命名
        // 后的 info 事件都靠它刷新头部与列表
        applyTitle(
          sid,
          info.title,
          typeof info.stored_session_id === 'string'
            ? info.stored_session_id
            : undefined,
        );
        return;
      }
      if (type === 'session.title') {
        // 首轮自动命名推送。注意 payload.session_id 是持久化 id（事件帧的
        // session_id 才是 live sid，wireEvents 已用它作 key）
        const p = (payload ?? {}) as {session_id?: string; title?: string};
        applyTitle(sid, p.title, p.session_id);
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
      const {name} = parseSlash(command);
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
      // /title 由服务端 slash worker 直接写库（回显 "Session title set: …"），
      // 服务端不推 session.title/session.info 事件 → 主动读回权威标题，
      // 否则头部/列表要等重连或重进才刷新
      if (name === 'title') {
        await get().refreshTitle(sid);
      }
    },

    async refreshTitle(sid) {
      try {
        const r = await getRpc().call<{title?: string; session_key?: string}>(
          'session.title',
          {session_id: sid},
        );
        applyTitle(sid, r?.title, r?.session_key);
      } catch (e) {
        // 读回失败不打扰用户：命令输出已显示结果，头部保持旧标题
        dlog(
          'WARN',
          `读回会话标题失败 ${sid.slice(0, 8)}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    },

    async syncSessionInfo(sid) {
      try {
        // RPC 顶层即 usage dict（与 session.usage 事件 payload.usage 同源）；
        // agent 未建时服务端返回 {calls,input,output,total} 零计数（无 model、
        // 无 context_*——落地后顶栏用量段自然不显示，属服务端口径）
        const usage = await getRpc().call<UsageInfo>('session.usage', {
          session_id: sid,
        });
        if (!usage || typeof usage !== 'object') {
          return;
        }
        // turn 已开始则让位：ticker 每秒推 session.usage，读回值必是旧的
        if (aggregators.get(sid)?.isStreaming()) {
          return;
        }
        const prev = get().bySession[sid] ?? EMPTY;
        const model = typeof usage.model === 'string' ? usage.model : '';
        set(s => ({
          bySession: {
            ...s.bySession,
            [sid]: {
              ...prev,
              info: {
                ...(prev.info ?? {}),
                usage,
                // usage.model 是当前生效模型，顺带校正模型段（服务端侧
                // 切模型未推 session.info 事件时也能对齐）
                ...(model ? {model} : null),
              },
            },
          },
        }));
      } catch (e) {
        // 读回失败不打扰用户（服务端已回收/live sid 失效等），顶栏保持现状
        dlog(
          'WARN',
          `读回会话用量失败 ${sid.slice(0, 8)}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    },

    async renameSession(sid, title) {
      const trimmed = title.trim();
      if (!trimmed) {
        return;
      }
      const r = await getRpc().call<{title?: string}>('session.title', {
        session_id: sid,
        title: trimmed,
      });
      // 服务端 sanitize 后的值优先；缺省用提交值
      applyTitle(sid, r?.title ?? trimmed);
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
        let pendingApprovals: OneOrMany<ApprovalRequestPayload> | undefined;
        let pendingClarifies: OneOrMany<ClarifyRequestPayload> | undefined;
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
            throw new Error(t('chat.sshRequiredForHistory'));
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
          // 派生会话的服务端标题为空：先用来源会话标题占位（首轮自动命名后覆盖）
          title: st?.title,
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
          message: t('chat.forkFailed', {
            message: e instanceof Error ? e.message : String(e),
          }),
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
            message: t('chat.imageUploadFailed', {
              message: e instanceof Error ? e.message : String(e),
            }),
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
          message: t('chat.imageRemoveFailed', {
            message: e instanceof Error ? e.message : String(e),
          }),
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
          message: t('chat.interruptFailed', {
            message: e instanceof Error ? e.message : String(e),
          }),
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
          message: t('chat.approvalFailed', {
            message: e instanceof Error ? e.message : String(e),
          }),
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
          message: t('chat.clarifyFailed', {
            message: e instanceof Error ? e.message : String(e),
          }),
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
