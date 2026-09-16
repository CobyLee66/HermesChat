/**
 * 事件流 + 历史投影 → TimelineItem[] 聚合器。
 * 每个会话一个实例。所有 apply* 之后 items 数组换新引用（配合 zustand/FlatList）。
 */

import {diffFromResult} from './diffText';
import {parseMessageText} from './references';
import {t} from '../i18n';
import type {
  ApprovalCardItem,
  ApprovalRequestPayload,
  AssistantBlock,
  AssistantMsg,
  ClarifyCardItem,
  ClarifyQuestion,
  ClarifyRequestPayload,
  ErrorPayload,
  ExpirePayload,
  ImageRef,
  MessageCompletePayload,
  MessageDeltaPayload,
  MessageInterimPayload,
  ProjectedMessage,
  StatusUpdatePayload,
  TextDeltaPayload,
  TimelineItem,
  ToolCallBlock,
  ToolCompletePayload,
  ToolProgressPayload,
  ToolStartPayload,
  UserMsg,
} from './types';

/** session.resume 返回的 turn 进行中快照（服务端 inflight 字段）。 */
export interface InflightSnapshot {
  user?: string;
  assistant?: string;
  streaming?: boolean;
  error?: string;
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

function stringifyResult(result: unknown): string {
  if (result === undefined || result === null) {
    return '';
  }
  if (typeof result === 'string') {
    return result;
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/**
 * 从 wire payload（clarify.request / resume 快照）或历史 tool 行 args 归一化
 * 问题列表。单问 {question, choices, multi_select?}；批量 {questions:[...]}。
 * 无法归一化出问题（缺 question 文本）返回 null。
 */
function normalizeClarifyQuestions(source: {
  question?: unknown;
  choices?: unknown;
  multi_select?: unknown;
  questions?: unknown;
}): ClarifyQuestion[] | null {
  const rawQuestions =
    Array.isArray(source.questions) && source.questions.length > 0
      ? source.questions
      : [
          {
            qid: '',
            question: source.question,
            choices: source.choices,
            multi_select: source.multi_select,
          },
        ];
  const questions = (rawQuestions as Record<string, unknown>[])
    .map(q => ({
      qid: typeof q.qid === 'string' ? q.qid : '',
      question: typeof q.question === 'string' ? q.question : '',
      choices: Array.isArray(q.choices)
        ? q.choices.filter((c): c is string => typeof c === 'string')
        : [],
      multiSelect: q.multi_select === true,
    }))
    .filter(q => q.question);
  return questions.length > 0 ? questions : null;
}

/** clarify 卡是否全部问题已答（交互结束的判定）。 */
function clarifyFullyAnswered(card: ClarifyCardItem): boolean {
  return card.questions.every(q => card.answeredQids.includes(q.qid ?? ''));
}

export class TimelineAggregator {
  private items: TimelineItem[] = [];
  /** 当前流式助手消息（message.start 之后、message.complete 之前） */
  private current: AssistantMsg | null = null;
  /** 最近一次 status.update（UI 状态条用，不进时间线） */
  lastStatus: {kind: string; text: string} | null = null;
  /**
   * 最近一次 thinking.delta 的占位文本（如 `(´･_･\`) processing…`）。
   * 服务端把它当 busy 指示器改写：每次 API 调用发一条新占位、结束时发
   * 空串清除（桌面端同款语义——不进正文，只做状态行，最新覆盖）。
   */
  lastThinkingHint: string | null = null;
  /**
   * 交互卡（clarify/approval）结束后是否已封存流式消息、正在等续写。
   * 挂起交互期间 turn 仍在服务端运行：作答/超时把 current 封存（让续写落到
   * 卡片下方）后、下一个 delta/complete 到来前的窗口里，isStreaming 仍应
   * 为 true（busy 不能闪断，用量读回/历史重拉也要继续让位）。
   */
  private sealedInteraction = false;
  /**
   * 交互封存时累计的已展示文本长度（concatTextOf 口径）。turn 若在作答后
   * 立即结束（无续写 delta），孤儿 message.complete 的整段权威文本要截掉
   * 这段前缀再落新消息，否则同一段文本在两张消息里重复。
   */
  private sealedPrefixLen: number | null = null;
  /** tool.start(clarify) 记录的 tool_id，clarify.request 到达时配对到卡片 */
  private clarifyToolId: string | null = null;

  getItems(): TimelineItem[] {
    return this.items;
  }

  isStreaming(): boolean {
    if (this.current && this.current.streaming) {
      return true;
    }
    return this.sealedInteraction;
  }

  // ─── 历史投影 ──────────────────────────────────────────────

  /**
   * message.complete 后置位一次：本轮流式尾部是 inflight 纯文本投影重建的
   * （fromInflightProjection），结构块（工具卡/思考）缺失，需重拉历史重建。
   * 由 chat store 经 takeNeedsHistoryRefresh 消费。
   */
  private needsHistoryRefresh = false;

  /** 用 session.create/resume 返回的 messages 重建时间线。 */
  hydrate(messages: ProjectedMessage[]) {
    this.items = [];
    this.current = null;
    this.sealedText = false;
    this.sealedInteraction = false;
    this.sealedPrefixLen = null;
    this.clarifyToolId = null;
    this.lastStatus = null;
    this.lastThinkingHint = null;
    this.needsHistoryRefresh = false;
    for (const m of messages) {
      if (!m || typeof m !== 'object') {
        continue;
      }
      // 压缩 handoff 等隐藏行
      if (m.display_kind === 'hidden' || m.display_kind === 'compaction') {
        continue;
      }
      if (m.role === 'user') {
        // 历史文本里可能带 @image:/@file: 指令行和内嵌 data URL（图片 turn）
        const parsed = parseMessageText(m.text ?? '');
        if (
          !parsed.text &&
          parsed.images.length === 0 &&
          parsed.files.length === 0
        ) {
          continue;
        }
        this.push({
          kind: 'user',
          id: nextId('u'),
          text: parsed.text,
          timestamp: m.timestamp,
          images: parsed.images,
          files: parsed.files,
        });
      } else if (m.role === 'assistant') {
        const blocks: AssistantBlock[] = [];
        const reasoning =
          typeof m.reasoning === 'string' ? m.reasoning.trim() : '';
        if (reasoning) {
          blocks.push({type: 'thinking', text: reasoning});
        }
        const parsed = parseMessageText(m.text ?? '');
        if (parsed.text) {
          blocks.push({type: 'text', text: parsed.text});
        }
        for (const image of parsed.images) {
          blocks.push({type: 'image', image});
        }
        for (const file of parsed.files) {
          blocks.push({type: 'file', file});
        }
        if (blocks.length === 0) {
          continue;
        }
        this.push({
          kind: 'assistant',
          id: nextId('a'),
          blocks,
          streaming: false,
          timestamp: m.timestamp,
        });
      } else if (m.role === 'tool') {
        // 历史 clarify 工具行 → 只读已答卡（位置 = 行位置，即澄清发生处）。
        // 投影的 tool 行只带 args 不带 result（server `_history_to_messages`），
        // 答案文本不可得，题目一律显示「已作答」。
        if (m.name === 'clarify') {
          const questions = normalizeClarifyQuestions(m.args ?? {});
          if (questions) {
            this.push({
              kind: 'clarify',
              id: nextId('cl'),
              requestId: nextId('clh'),
              questions,
              answeredQids: questions.map(q => q.qid ?? ''),
              fromHistory: true,
            });
            continue;
          }
        }
        const tool: ToolCallBlock = {
          toolId: m.row_id !== undefined ? `hist-${m.row_id}` : nextId('t'),
          name: m.name ?? 'tool',
          context: m.context,
          args: m.args,
          status: 'done',
        };
        this.push({
          kind: 'assistant',
          id: nextId('a'),
          blocks: [{type: 'tool', tool}],
          streaming: false,
          timestamp: m.timestamp,
        });
      } else if (m.role === 'system') {
        const text = (m.text ?? '').trim();
        if (text) {
          this.push({
            kind: 'system',
            id: nextId('s'),
            eventKind: 'history',
            text,
          });
        }
      }
    }
  }

  // ─── 事件应用 ──────────────────────────────────────────────

  /** 返回 true 表示事件被处理（已知类型）。 */
  applyEvent(type: string, payload: unknown): boolean {
    const p = (payload ?? {}) as Record<string, unknown>;
    switch (type) {
      case 'message.start':
        this.onMessageStart();
        return true;
      case 'message.delta':
        this.onMessageDelta(p as unknown as MessageDeltaPayload);
        return true;
      case 'message.interim':
        this.onMessageInterim(p as unknown as MessageInterimPayload);
        return true;
      case 'message.complete':
        this.onMessageComplete(p as unknown as MessageCompletePayload);
        return true;
      case 'thinking.delta':
        this.onThinkingDelta(p as unknown as TextDeltaPayload);
        return true;
      case 'reasoning.delta':
        this.onTextDelta('reasoning', p as unknown as TextDeltaPayload);
        return true;
      case 'tool.start':
        this.onToolStart(p as unknown as ToolStartPayload);
        return true;
      case 'tool.progress':
        this.onToolProgress(p as unknown as ToolProgressPayload);
        return true;
      case 'tool.complete':
        this.onToolComplete(p as unknown as ToolCompletePayload);
        return true;
      case 'approval.request':
        this.onApprovalRequest(p as unknown as ApprovalRequestPayload);
        return true;
      case 'clarify.request':
        this.onClarifyRequest(p as unknown as ClarifyRequestPayload);
        return true;
      case 'approval.expire':
      case 'clarify.expire':
        this.onExpire(p as unknown as ExpirePayload);
        return true;
      case 'error':
        this.onError(p as unknown as ErrorPayload);
        return true;
      case 'status.update':
        this.onStatusUpdate(p as unknown as StatusUpdatePayload);
        return true;
      default:
        return false;
    }
  }

  // ─── 审批 ──────────────────────────────────────────────────

  /** 用户点选审批后调用：标记卡片已处理（UI 将其移除/禁用）。 */
  resolveApproval(requestId: string, choice: ApprovalCardItem['choices'][number]) {
    const idx = this.items.findIndex(
      it => it.kind === 'approval' && it.requestId === requestId,
    );
    if (idx < 0) {
      return;
    }
    const card = this.items[idx] as ApprovalCardItem;
    if (card.resolved !== undefined) {
      return;
    }
    this.replaceAt(idx, {...card, resolved: choice});
    // 点选即交互结束：封存当前流式消息，后续输出落到卡片下方（归位）
    this.sealInteractive();
  }

  private onApprovalRequest(p: ApprovalRequestPayload) {
    if (!p.request_id) {
      return;
    }
    // 去重（断线重放同 request_id）
    const existing = this.items.findIndex(
      it => it.kind === 'approval' && it.requestId === p.request_id,
    );
    const card: ApprovalCardItem = {
      kind: 'approval',
      id: nextId('ap'),
      requestId: p.request_id,
      command: p.command,
      description: p.description,
      choices:
        Array.isArray(p.choices) && p.choices.length > 0
          ? p.choices
          : ['once', 'session', 'always', 'deny'],
    };
    if (existing >= 0) {
      this.replaceAt(existing, card);
    } else {
      this.push(card);
    }
  }

  // ─── 澄清提问（clarify） ────────────────────────────────────

  /** 用户作答后调用：把该问题标记为已答（批量逐题），answer 为展示用文本。 */
  resolveClarify(requestId: string, questionId: string, answer?: string) {
    this.applyClarifyAnswers(requestId, [{qid: questionId, answer}]);
  }

  /** 整体提交时置/清 submitting（UI 禁用卡片交互防重复提交）。 */
  setClarifySubmitting(requestId: string, submitting: boolean) {
    const idx = this.items.findIndex(
      it => it.kind === 'clarify' && it.requestId === requestId,
    );
    if (idx < 0) {
      return;
    }
    const card = this.items[idx] as ClarifyCardItem;
    this.replaceAt(idx, {...card, submitting});
  }

  /**
   * 把若干 qid 标记为已答（答案文本可选）。全部问题答完时封存当前流式
   * 消息——服务端释放 turn 后的续写会作为新消息落到卡片下方，卡片就地
   * 获得正确时序位置（不再钉在列表底部）。
   */
  private applyClarifyAnswers(
    requestId: string,
    entries: {qid: string; answer?: string}[],
  ) {
    const idx = this.items.findIndex(
      it => it.kind === 'clarify' && it.requestId === requestId,
    );
    if (idx < 0) {
      return;
    }
    const card = this.items[idx] as ClarifyCardItem;
    const wasComplete = clarifyFullyAnswered(card);
    const answeredQids = [...card.answeredQids];
    const answers = {...(card.answers ?? {})};
    for (const {qid, answer} of entries) {
      // 只收卡片里真实存在的问题（防 echo/调用方串错 qid）
      if (!card.questions.some(q => (q.qid ?? '') === qid)) {
        continue;
      }
      if (!answeredQids.includes(qid)) {
        answeredQids.push(qid);
      }
      if (answer !== undefined) {
        answers[qid] = answer;
      }
    }
    const next: ClarifyCardItem = {...card, answeredQids, answers};
    this.replaceAt(idx, next);
    if (!wasComplete && clarifyFullyAnswered(next)) {
      this.sealInteractive();
    }
  }

  private onClarifyRequest(p: ClarifyRequestPayload) {
    if (!p.request_id) {
      return;
    }
    // 单问 {question, choices, multi_select?}；批量 {questions:[...]}
    const questions = normalizeClarifyQuestions(p);
    if (!questions) {
      return;
    }
    // 去重（断线重放同 request_id）
    const existingIdx = this.items.findIndex(
      it => it.kind === 'clarify' && it.requestId === p.request_id,
    );
    const existing = existingIdx >= 0
      ? (this.items[existingIdx] as ClarifyCardItem)
      : null;
    // resume 快照回放批量澄清时带 answers（服务端已锁定的 qid→答案，见
    // _pending_clarify_request_payload）：播种已答状态与展示文本，否则重进
    // 会话后已作答的题目又变成可答（官方 desktop 的 lockedAnswers 恢复同款）。
    const seeded =
      p.answers && typeof p.answers === 'object' ? p.answers : null;
    const answeredQids = seeded
      ? questions.map(q => q.qid ?? '').filter(qid => qid in seeded)
      : [];
    const answers: Record<string, string> = {};
    if (seeded) {
      for (const qid of answeredQids) {
        const v = seeded[qid];
        if (typeof v === 'string') {
          answers[qid] = v;
        }
      }
    }
    const card: ClarifyCardItem = {
      kind: 'clarify',
      id: existing ? existing.id : nextId('cl'),
      requestId: p.request_id,
      questions,
      answeredQids,
      ...(Object.keys(answers).length > 0 ? {answers} : null),
      // tool.start(clarify) 先于 clarify.request 到达：记下配对 tool_id，
      // tool.complete 时按回显答案收敛（其他端作答场景）。重放时本地
      // clarifyToolId 已丢，保留卡片上旧值。
      linkedToolId:
        this.clarifyToolId ?? existing?.linkedToolId ?? undefined,
    };
    if (existingIdx >= 0) {
      this.replaceAt(existingIdx, card);
    } else {
      this.push(card);
    }
    if (this.clarifyToolId) {
      this.clarifyToolId = null;
    }
    // 快照已全答（服务端竞态窗口）：交互实际已结束，封存防续写错位
    if (!existing && clarifyFullyAnswered(card)) {
      this.sealInteractive();
    }
  }

  /**
   * tool.complete(clarify) 的答案回显收敛：其他端作答/服务端释放的权威
   * 信号。result：单问=纯文本；批量=JSON {"answers":{qid:answer},
   * "timed_out"?}（server `_block` 批量读出）。配对按 linkedToolId，
   * 缺失时退到唯一的未答完卡片。
   */
  private applyClarifyEcho(p: ToolCompletePayload) {
    let target: ClarifyCardItem | undefined;
    for (const it of this.items) {
      if (it.kind === 'clarify' && it.linkedToolId === p.tool_id) {
        target = it;
        break;
      }
    }
    if (!target) {
      const pending = this.items.filter(
        it =>
          it.kind === 'clarify' &&
          !clarifyFullyAnswered(it as ClarifyCardItem),
      ) as ClarifyCardItem[];
      if (pending.length === 1) {
        target = pending[0];
      }
    }
    if (!target) {
      return;
    }
    const resultText =
      typeof p.result_text === 'string' && p.result_text
        ? p.result_text
        : stringifyResult(p.result);
    const entries: {qid: string; answer?: string}[] = [];
    let parsed: unknown = null;
    if (resultText) {
      try {
        parsed = JSON.parse(resultText);
      } catch {
        // 单问纯文本答案
      }
    }
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      parsed !== null &&
      'answers' in parsed
    ) {
      const echo = (parsed as {answers?: unknown}).answers;
      if (echo && typeof echo === 'object') {
        for (const q of target.questions) {
          const qid = q.qid ?? '';
          const v = (echo as Record<string, unknown>)[qid];
          entries.push({
            qid,
            answer: typeof v === 'string' ? v : undefined,
          });
        }
      }
    } else if (resultText) {
      entries.push({qid: '', answer: resultText});
    }
    this.applyClarifyAnswers(target.requestId, entries);
  }

  // ─── 交互超时（approval/clarify.expire） ────────────────────

  private onExpire(p: ExpirePayload) {
    if (!p.request_id) {
      return;
    }
    const idx = this.items.findIndex(
      it =>
        (it.kind === 'approval' || it.kind === 'clarify') &&
        it.requestId === p.request_id,
    );
    if (idx < 0) {
      return;
    }
    const card = this.items[idx];
    this.replaceAt(idx, {...card, expired: true} as TimelineItem);
    // 交互已答完/已处理的卡：交互早在 resolve 时结束（流式消息已封存过），
    // 此时 current 可能是续写中的新消息，不能再封。
    const ended =
      card.kind === 'approval'
        ? card.resolved !== undefined
        : card.kind === 'clarify'
          ? clarifyFullyAnswered(card)
          : false;
    if (!ended) {
      // 超时即交互结束（服务端拿超时结果继续跑）：封存流式消息，续写落到卡片下方
      this.sealInteractive();
    }
  }

  // ─── 内部：消息流 ─────────────────────────────────────────

  private onMessageStart() {
    // 上一个流式消息未正常结束时先封存
    if (this.current && this.current.streaming) {
      this.sealCurrent();
    }
    const msg: AssistantMsg = {
      kind: 'assistant',
      id: nextId('a'),
      blocks: [],
      streaming: true,
    };
    this.current = msg;
    this.push(msg);
  }

  private onMessageDelta(p: MessageDeltaPayload) {
    if (typeof p.text !== 'string' || p.text.length === 0) {
      return;
    }
    const msg = this.ensureCurrent();
    const last = msg.blocks[msg.blocks.length - 1];
    if (last && last.type === 'text' && !this.sealedText) {
      last.text += p.text;
    } else {
      msg.blocks.push({type: 'text', text: p.text});
      this.sealedText = false;
    }
    this.touchCurrent();
  }

  /** interim(already_streamed) 之后，下一个 delta 必须开新 text 块 */
  private sealedText = false;

  private onMessageInterim(p: MessageInterimPayload) {
    const msg = this.ensureCurrent();
    if (p.already_streamed) {
      // 文本已经通过 delta 流出过：密封当前 text 块，后续 delta 开新块
      const last = msg.blocks[msg.blocks.length - 1];
      if (last && last.type === 'text') {
        this.sealedText = true;
      }
    } else if (typeof p.text === 'string' && p.text.trim()) {
      msg.blocks.push({type: 'text', text: p.text});
      // 未流出的 interim 是完整段落：后续 delta 开新块，不接在它后面
      this.sealedText = true;
    }
    this.touchCurrent();
  }

  private onMessageComplete(p: MessageCompletePayload) {
    const msg = this.current;
    if (!msg) {
      // 没有 message.start 的孤儿 complete：直接落成一条完整消息
      const blocks: AssistantBlock[] = [];
      let text = typeof p.text === 'string' ? p.text : '';
      // 交互封存后的孤儿 complete：权威文本覆盖整 turn，截掉封存时已展示的
      // 前缀，否则同一段文本在两张消息里重复（「作答后 turn 立即结束、无
      // 续写 delta」的路径）
      if (this.sealedPrefixLen !== null) {
        text = text.slice(this.sealedPrefixLen);
      }
      if (text && text.trim()) {
        blocks.push({type: 'text', text});
      }
      if (p.status === 'error') {
        blocks.push({
          type: 'error',
          text: p.error || p.text || t('rpc.unknownError'),
        });
      }
      if (blocks.length > 0) {
        this.push({
          kind: 'assistant',
          id: nextId('a'),
          blocks: this.extractMediaBlocks(blocks),
          streaming: false,
        });
      }
      this.sealedInteraction = false;
      this.sealedPrefixLen = null;
      return;
    }
    // 若流式 delta 未产生文本（或 complete 文本更全），用 complete 文本补齐
    const hasText = msg.blocks.some(b => b.type === 'text' && b.text.trim());
    if (!hasText && typeof p.text === 'string' && p.text.trim()) {
      msg.blocks.push({type: 'text', text: p.text});
    } else if (typeof p.text === 'string' && p.text && !this.sealedText) {
      // 单 text 块时用 complete 的权威文本回填：重进/断线重挂的竞态窗口里
      // 可能丢过几个 delta（complete 文本是流式文本的严格前缀扩展时替换）
      const textBlocks = msg.blocks.filter(b => b.type === 'text');
      if (textBlocks.length === 1) {
        const block = textBlocks[0] as {type: 'text'; text: string};
        if (p.text.startsWith(block.text) && p.text.length > block.text.length) {
          block.text = p.text;
        }
      }
    }
    if (p.status === 'error') {
      msg.blocks.push({
        type: 'error',
        text: p.error || p.text || t('rpc.unknownError'),
      });
    }
    if (
      typeof p.reasoning === 'string' &&
      p.reasoning.trim() &&
      !msg.blocks.some(b => b.type === 'reasoning' || b.type === 'thinking')
    ) {
      msg.blocks.unshift({type: 'thinking', text: p.reasoning});
    }
    // 文本块里的 @image:/@file: 指令与内嵌图片在收尾时一次性提取
    // （流式中途不解析，避免吃到半截指令）
    msg.blocks = this.extractMediaBlocks(msg.blocks);
    msg.streaming = false;
    this.sealedText = false;
    this.lastThinkingHint = null;
    this.sealedInteraction = false;
    this.sealedPrefixLen = null;
    if (msg.fromInflightProjection) {
      // 本轮尾部是重进 mid-turn 会话时的纯文本投影（工具卡/思考块缺失）；
      // turn 已结束、历史投影已含结构——交给 chat store 重拉重建。
      this.needsHistoryRefresh = true;
    }
    this.touchCurrent();
    this.current = null;
  }

  /**
   * message.complete 之后由 chat store 调用：本轮流式尾部若是 inflight
   * 纯文本投影重建的（结构块缺失），返回 true 一次——调用方应随即用
   * session.history 重拉历史并 hydrate 重建完整结构。
   */
  takeNeedsHistoryRefresh(): boolean {
    const v = this.needsHistoryRefresh;
    this.needsHistoryRefresh = false;
    return v;
  }

  /** 把 text 块里的图片/文件引用拆成独立块（原位展开，保持顺序）。 */
  private extractMediaBlocks(blocks: AssistantBlock[]): AssistantBlock[] {
    let hasMedia = false;
    const out: AssistantBlock[] = [];
    for (const b of blocks) {
      if (b.type !== 'text') {
        out.push(b);
        continue;
      }
      const parsed = parseMessageText(b.text);
      if (parsed.images.length === 0 && parsed.files.length === 0) {
        out.push(b);
        continue;
      }
      hasMedia = true;
      if (parsed.text) {
        out.push({type: 'text', text: parsed.text});
      }
      for (const image of parsed.images) {
        out.push({type: 'image', image});
      }
      for (const file of parsed.files) {
        out.push({type: 'file', file});
      }
    }
    return hasMedia ? out : blocks;
  }

  private onTextDelta(kind: 'thinking' | 'reasoning', p: TextDeltaPayload) {
    if (typeof p.text !== 'string' || p.text.length === 0) {
      return;
    }
    const msg = this.ensureCurrent();
    const last = msg.blocks[msg.blocks.length - 1];
    if (last && last.type === kind) {
      last.text += p.text;
    } else {
      msg.blocks.push({type: kind, text: p.text});
    }
    this.touchCurrent();
  }

  /**
   * thinking.delta = 服务端 busy 指示器改写（占位 kaomoji/等待说明），
   * 非流式思考内容：非空文本最新覆盖，空串清除。不进时间线正文。
   */
  private onThinkingDelta(p: TextDeltaPayload) {
    const text = typeof p.text === 'string' ? p.text : '';
    if (text.trim().length === 0) {
      this.lastThinkingHint = null;
    } else {
      this.lastThinkingHint = text;
    }
  }

  // ─── 内部：工具 ───────────────────────────────────────────

  private onToolStart(p: ToolStartPayload) {
    if (!p.tool_id) {
      return;
    }
    // 重放/重复 start：已存在同名块则忽略
    if (this.findToolBlock(p.tool_id)) {
      return;
    }
    // clarify 是交互卡不是工具卡：只记 tool_id 供 clarify.request 配对
    // （tool.start 先于 clarify.request 到达），完成回显由 onToolComplete
    // 收敛到卡片，全程不建工具块——避免与澄清卡双重展示。
    if (p.name === 'clarify') {
      this.clarifyToolId = p.tool_id;
      return;
    }
    const msg = this.ensureCurrent();
    const tool: ToolCallBlock = {
      toolId: p.tool_id,
      name: p.name ?? 'tool',
      context: p.context,
      args: p.args,
      status: 'running',
    };
    msg.blocks.push({type: 'tool', tool});
    this.touchCurrent();
  }

  private onToolProgress(p: ToolProgressPayload) {
    if (!p.tool_id) {
      return;
    }
    const found = this.findToolBlock(p.tool_id);
    if (!found) {
      return;
    }
    const text = p.preview ?? p.text;
    if (typeof text === 'string' && text) {
      found.tool.progress = text;
      this.bump();
    }
  }

  private onToolComplete(p: ToolCompletePayload) {
    if (!p.tool_id) {
      return;
    }
    // clarify 工具：结果回显收敛到澄清卡（见 applyClarifyEcho），不建工具块
    if (p.name === 'clarify' || this.clarifyToolId === p.tool_id) {
      this.clarifyToolId = null;
      this.applyClarifyEcho(p);
      return;
    }
    const found = this.findToolBlock(p.tool_id);
    const resultText =
      typeof p.result_text === 'string' && p.result_text
        ? p.result_text
        : stringifyResult(p.result);
    if (found) {
      const {tool} = found;
      tool.status = 'done';
      if (p.args !== undefined) {
        tool.args = p.args;
      }
      if (resultText) {
        tool.result = resultText;
      }
      if (p.summary) {
        tool.summary = p.summary;
      }
      if (typeof p.duration_s === 'number') {
        tool.durationS = p.duration_s;
      }
      if (p.inline_diff) {
        tool.inlineDiff = p.inline_diff;
      } else {
        // patch 等工具的原始 unified diff 在 result JSON 的 diff 字段里
        const rawDiff = diffFromResult(p.result);
        if (rawDiff) {
          tool.inlineDiff = rawDiff;
        }
      }
      this.bump();
      return;
    }
    // complete 没有对应 start（中途接入）：补一张已完成卡片
    const msg = this.ensureCurrent();
    const tool: ToolCallBlock = {
      toolId: p.tool_id,
      name: p.name ?? 'tool',
      args: p.args,
      status: 'done',
      result: resultText || undefined,
      summary: p.summary,
      durationS: typeof p.duration_s === 'number' ? p.duration_s : undefined,
      inlineDiff: p.inline_diff || diffFromResult(p.result) || undefined,
    };
    msg.blocks.push({type: 'tool', tool});
    this.touchCurrent();
  }

  /** 按 tool_id 找工具块（从后往前，start/complete 合并）。 */
  private findToolBlock(
    toolId: string,
  ): {msg: AssistantMsg; tool: ToolCallBlock} | null {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.kind !== 'assistant') {
        continue;
      }
      for (const b of it.blocks) {
        if (b.type === 'tool' && b.tool.toolId === toolId) {
          return {msg: it, tool: b.tool};
        }
      }
    }
    return null;
  }

  // ─── 内部：错误与状态 ─────────────────────────────────────

  private onError(p: ErrorPayload) {
    const text = p.message || t('rpc.unknownError');
    this.lastThinkingHint = null;
    // 流式进行中：错误块挂到当前消息；否则独立红条
    if (this.current && this.current.streaming) {
      this.current.blocks.push({type: 'error', text});
      this.current.streaming = false;
      this.touchCurrent();
      this.current = null;
    } else {
      this.push({kind: 'system', id: nextId('s'), eventKind: 'error', text});
    }
    // 错误终结 turn：交互封存窗口一并结束
    this.sealedInteraction = false;
    this.sealedPrefixLen = null;
  }

  private onStatusUpdate(p: StatusUpdatePayload) {
    this.lastStatus = {kind: p.kind ?? 'status', text: p.text ?? ''};
  }

  // ─── 用户消息（本地回显） ─────────────────────────────────

  /**
   * 追加用户气泡。text 里的 @file:/@image: 指令会被剥离成卡片/图片；
   * images 为已通过 image.attach_bytes 排队到 session 的图片（随本条 prompt
   * 进上下文，本地直接回显缩略图，不等 resume 的历史投影）。
   */
  /** 追加系统灰条（斜杠命令回显/输出等本地生成的非对话内容）。 */
  appendSystemMessage(text: string, eventKind = 'slash') {
    this.push({kind: 'system', id: nextId('s'), eventKind, text});
  }

  appendUserMessage(text: string, images: ImageRef[] = []): UserMsg {
    const parsed = parseMessageText(text);
    const msg: UserMsg = {
      kind: 'user',
      id: nextId('u'),
      text: parsed.text,
      images: [...images, ...parsed.images],
      files: parsed.files,
    };
    this.push(msg);
    return msg;
  }

  // ─── 重进/重挂会话：恢复 turn 进行中的流式尾部 ─────────────

  /**
   * hydrate 之后调用：按 resume 结果的 running/inflight 重建「正在进行的
   * turn」尾部，后续 delta/工具事件继续接到这条消息上。
   *
   * - running=true 但 inflight 为空（如 prompt 排队中）也建空流式尾部，
   *   否则下一次事件快照重算 busy 会闪断；
   * - previousStreaming：重挂前本地聚合器的流式消息（同一 turn 且服务端
   *   文本是它的前缀扩展时直接复用——它的工具卡/思考块比服务端纯文本
   *   快照丰富，对齐桌面端 preserveStructuralParts 的取舍）；
   * - inflight.user：历史投影通常已含本轮 prompt，尾部重复时不再补；
   * - inflight.assistant：已流出的部分文本，作为流式消息的初始 text 块。
   */
  restoreLiveTail(
    running: boolean,
    inflight: InflightSnapshot | null | undefined,
    previousStreaming?: AssistantMsg | null,
  ) {
    const hasInflight =
      !!inflight &&
      (!!inflight.user?.trim() || !!inflight.assistant || !!inflight.streaming);
    if (!running && !hasInflight) {
      return;
    }
    // 本轮 prompt 不在历史尾部时补一条用户气泡
    if (inflight?.user?.trim()) {
      const parsed = parseMessageText(inflight.user);
      const last = this.items[this.items.length - 1];
      const alreadyAtTail =
        last &&
        last.kind === 'user' &&
        last.text === parsed.text;
      if (!alreadyAtTail) {
        this.appendUserMessage(inflight.user);
      }
    }
    const serverText = typeof inflight?.assistant === 'string' ? inflight.assistant : '';
    let msg: AssistantMsg;
    const prevText = previousStreaming ? this.concatTextOf(previousStreaming) : '';
    if (
      previousStreaming &&
      serverText &&
      prevText &&
      serverText.startsWith(prevText)
    ) {
      // 同一 turn：保留本地流式消息（工具卡/思考块都在），文本取更全的一方。
      // serverText 覆盖全部已流出文本：替换首个 text 块、丢弃其余（其内容
      // 已含在 serverText 前缀里，保留会重复），非文本块原位不动。
      msg = {...previousStreaming, blocks: previousStreaming.blocks.map(b => ({...b}))};
      if (serverText.length > prevText.length) {
        const blocks: AssistantBlock[] = [];
        let textInserted = false;
        for (const b of msg.blocks) {
          if (b.type === 'text') {
            if (!textInserted) {
              blocks.push({type: 'text', text: serverText});
              textInserted = true;
            }
          } else {
            blocks.push(b);
          }
        }
        if (!textInserted) {
          blocks.push({type: 'text', text: serverText});
        }
        msg.blocks = blocks;
      }
    } else {
      // 纯文本投影重建：App 重启后本地结构块已不在（previousStreaming 为空或
      // 对不上），尾部只有文字没有工具卡/思考块——打标，turn 结束时由
      // chat store 用 session.history 重拉历史重建（见 takeNeedsHistoryRefresh）。
      msg = {
        kind: 'assistant',
        id: nextId('a'),
        blocks: serverText ? [{type: 'text', text: serverText}] : [],
        streaming: true,
        fromInflightProjection: true,
      };
    }
    msg.streaming = true;
    this.current = msg;
    this.sealedText = false;
    this.sealedInteraction = false;
    this.sealedPrefixLen = null;
    this.push(msg);
  }

  /** 取当前流式消息（重挂迁移用；无则 null）。 */
  takeStreamingTail(): AssistantMsg | null {
    return this.current && this.current.streaming ? this.current : null;
  }

  // ─── 工具方法 ─────────────────────────────────────────────

  /** 拼接消息里全部 text 块（前缀扩展比较用）。 */
  private concatTextOf(msg: AssistantMsg): string {
    return msg.blocks
      .filter(b => b.type === 'text')
      .map(b => (b as {type: 'text'; text: string}).text)
      .join('');
  }

  private ensureCurrent(): AssistantMsg {
    if (!this.current || !this.current.streaming) {
      const msg: AssistantMsg = {
        kind: 'assistant',
        id: nextId('a'),
        blocks: [],
        streaming: true,
      };
      this.current = msg;
      this.push(msg);
    }
    return this.current;
  }

  private sealCurrent() {
    if (this.current) {
      this.current.streaming = false;
      this.touchCurrent();
      this.current = null;
    }
  }

  /**
   * 交互卡（clarify/approval）结束（全答/点选/超时）时封存当前流式消息：
   * 服务端释放 turn 后的续写经 ensureCurrent 落到卡片**下方**的新消息，
   * 卡片就地获得正确时序位置。同时置 sealedInteraction（busy 保持到
   * 续写/complete 到来）并累计 sealedPrefixLen（孤儿 complete 去重）。
   */
  private sealInteractive() {
    if (this.current && this.current.streaming) {
      this.sealedPrefixLen =
        (this.sealedPrefixLen ?? 0) + this.concatTextOf(this.current).length;
      this.sealCurrent();
    }
    this.sealedInteraction = true;
  }

  private push(item: TimelineItem) {
    this.items = [...this.items, item];
  }

  private replaceAt(idx: number, item: TimelineItem) {
    this.items = this.items.map((it, i) => (i === idx ? item : it));
  }

  /** 当前流式消息内容变化：换引用触发 UI 更新。 */
  private touchCurrent() {
    if (!this.current) {
      return;
    }
    const cur = this.current;
    this.items = this.items.map(it =>
      it.id === cur.id ? {...cur, blocks: [...cur.blocks]} : it,
    );
  }

  private bump() {
    this.items = [...this.items];
  }
}
