/**
 * Hermes serve WS JSON-RPC 协议类型（见 docs/protocol.md）。
 * 事件信封: {"jsonrpc":"2.0","method":"event","params":{"type","session_id"?,"payload"}}
 */

// ─── JSON-RPC 帧 ────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

/** 服务端推送的事件帧（无 id，method="event"）。 */
export interface GatewayEventFrame<P = unknown> {
  jsonrpc: '2.0';
  method: 'event';
  params: {
    type: string;
    session_id?: string;
    payload?: P;
  };
}

export type ServerFrame = JsonRpcResponse | GatewayEventFrame;

// ─── 事件 payload ───────────────────────────────────────────────

export interface MessageDeltaPayload {
  text: string;
  rendered?: string;
}

/** message.interim：工具回合之间的中间助手文本。 */
export interface MessageInterimPayload {
  text: string;
  already_streamed?: boolean;
}

export interface UsageInfo {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** 本 gateway 进程累计（input/output/total/calls）；resume 后从 0 重计 */
  total?: number;
  /** 上下文窗口占用（至少跑过一轮后才出现） */
  context_used?: number;
  /** 模型上下文窗口上限（最大 token 限制） */
  context_max?: number;
  /** 0-100 整数 */
  context_percent?: number;
  [key: string]: unknown;
}

export interface MessageCompletePayload {
  text: string;
  usage?: UsageInfo;
  /** "complete" | "error" | "interrupted" */
  status?: string;
  rendered?: string;
  partial?: boolean;
  error?: string;
  recoverable?: boolean;
  reasoning?: string;
  warning?: string;
}

export interface TextDeltaPayload {
  text: string;
}

/** tool.start payload。注意: 80 字预览字段名是 context（不是 preview）。 */
export interface ToolStartPayload {
  tool_id: string;
  name: string;
  context?: string;
  args?: Record<string, unknown>;
  args_text?: string;
}

export interface ToolProgressPayload {
  tool_id?: string;
  name?: string;
  preview?: string;
  text?: string;
}

export interface ToolCompletePayload {
  tool_id: string;
  name: string;
  args?: Record<string, unknown>;
  result?: unknown;
  summary?: string;
  duration_s?: number;
  result_text?: string;
  inline_diff?: string;
}

export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny';

export interface ApprovalRequestPayload {
  request_id: string;
  /** 已脱敏 */
  command?: string;
  description?: string;
  pattern_key?: string;
  pattern_keys?: string[];
  choices: ApprovalChoice[];
  allow_permanent?: boolean;
  allow_session?: boolean;
  smart_denied?: boolean;
}

/** clarify.request 的单个子问题（批量时在 questions 数组里）。 */
export interface ClarifyQuestion {
  /** 服务端 wire id（q0..qN），clarify.respond 按它归答案 */
  qid?: string;
  question: string;
  choices: string[];
  multiSelect?: boolean;
}

/**
 * clarify.request payload：单问 {question, choices, multi_select?}；
 * 批量 {questions: [{qid, question, choices, multi_select}]}。
 */
export interface ClarifyRequestPayload {
  request_id: string;
  question?: string;
  choices?: string[];
  multi_select?: boolean;
  questions?: {
    qid?: string;
    question?: string;
    choices?: string[];
    multi_select?: boolean;
  }[];
}

/** *.expire 事件 payload（审批/澄清超时）。 */
export interface ExpirePayload {
  request_id?: string;
}

export interface StatusUpdatePayload {
  kind: string;
  text: string;
}

export interface ErrorPayload {
  message: string;
}

export interface SessionInfoPayload {
  model?: string;
  provider?: string;
  reasoning_effort?: string;
  fast?: boolean;
  yolo?: boolean;
  cwd?: string;
  branch?: string;
  title?: string;
  running?: boolean;
  usage?: UsageInfo;
  profile_name?: string;
  tools?: Record<string, string[]>;
  [key: string]: unknown;
}

export interface GatewayReadyPayload {
  skin?: Record<string, unknown>;
  change_events?: boolean;
}

// ─── RPC 结果类型 ───────────────────────────────────────────────

export interface ProfileInfo {
  name: string;
  path: string;
  is_default: boolean;
  model: string;
  provider: string;
  description: string;
  skill_count: number;
  last_session?: {
    id: string;
    title: string;
    preview: string;
    started_at: number;
    last_active?: number;
    message_count?: number;
  } | null;
  ui_meta?: Record<string, unknown>;
  has_avatar?: boolean;
}

export interface ProfileAsset {
  found: boolean;
  mime?: string;
  size?: number;
  /** data:<mime>;base64,... 形式，可直接喂给 <Image source={{uri}}> */
  data?: string;
}

export interface ModelProviderRow {
  slug: string;
  name: string;
  is_current?: boolean;
  models: string[];
  total_models?: number;
  authenticated?: boolean;
  featured_models?: string[];
  [key: string]: unknown;
}

export interface ModelOptionsResult {
  providers: ModelProviderRow[];
  model: string;
  provider: string;
  [key: string]: unknown;
}

/** 历史消息投影（session.create/resume 的 messages 字段）。 */
export interface ProjectedMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  text?: string;
  timestamp?: number;
  row_id?: number;
  display_kind?: string;
  display_metadata?: Record<string, unknown>;
  reasoning?: string;
  /** role=tool 时 */
  name?: string;
  context?: string;
  args?: Record<string, unknown>;
}

export interface SessionCreateResult {
  session_id: string;
  stored_session_id: string;
  message_count: number;
  messages: ProjectedMessage[];
  info: SessionInfoPayload;
}

export interface SessionResumeResult {
  session_id: string;
  stored_session_id?: string;
  resumed?: string;
  running?: boolean;
  status?: string;
  messages?: ProjectedMessage[];
  info?: SessionInfoPayload;
  /** 断线期间挂起的审批（事件单播给旧 transport，靠它恢复审批卡） */
  pending_approval?: ApprovalRequestPayload[];
  /** 断线期间挂起的澄清提问 */
  pending_clarify?: ClarifyRequestPayload[];
  inflight?: {
    user?: string;
    assistant?: string;
    streaming?: boolean;
    error?: string;
  } | null;
  [key: string]: unknown;
}

export interface SessionListRow {
  id: string;
  title: string;
  preview: string;
  started_at: number;
  message_count: number;
  source: string;
  /**
   * multiplex 归属标记：该行物理上在其它 profile 的 state.db
   * （客户端分组时打上，RPC 不返回——见 src/ssh/namespaceMap.ts）。
   */
  namespaced?: boolean;
  /** namespaced=true 时的物理宿主 profile（历史读取/派生用） */
  hostProfile?: string;
}

// ─── 附件 / profile 编辑 RPC 结果 ──────────────────────────────

/** image.attach_bytes / image.attach 结果。 */
export interface ImageAttachResult {
  attached: boolean;
  /** gateway 侧绝对路径（渲染走 /api/files/download） */
  path: string;
  /** 该 session 当前已排队图片数 */
  count: number;
  name?: string;
  width?: number;
  height?: number;
  bytes?: number;
  text?: string;
}

/** image.detach 结果。 */
export interface ImageDetachResult {
  detached: boolean;
  count: number;
}

/** file.attach 结果。 */
export interface FileAttachResult {
  attached: boolean;
  name: string;
  path: string;
  ref_path: string;
  /** 追加到输入框的引用文本（@file:…） */
  ref_text: string;
  uploaded?: boolean;
}

/** profiles.configure 结果：分节汇报成功。 */
export interface ProfilesConfigureResult {
  ok: boolean;
  applied?: Record<string, boolean>;
}

/** profiles.set_asset 结果（clear 时 size=0）。 */
export interface ProfilesSetAssetResult {
  ok: boolean;
  asset: string;
  size: number;
  removed?: number;
}

// ─── TimelineItem（UI 渲染模型） ────────────────────────────────

/**
 * 消息里的图片引用（见 docs/protocol.md §4）。
 * - path：gateway 侧绝对路径（持久化文本里的 `@image:<path>` 指令），
 *   渲染时走 `{httpUrl}/api/files/download?path=…&token=…`。
 * - uri：可直接渲染的 `data:` URI（image_url content part 经服务端
 *   `_coerce_message_text` 拍平进 text 后由客户端提取）。
 */
export interface ImageRef {
  path?: string;
  uri?: string;
}

/** 消息里的文件引用（`@file:<ref>` 指令）。 */
export interface FileRef {
  /** @file: 的原始值（可能带引号时已去除） */
  ref: string;
  /** 显示名（路径末段） */
  name: string;
}

export interface UserMsg {
  kind: 'user';
  id: string;
  /** 已剥离 @image:/@file: 指令与内嵌 data URL 的纯文本 */
  text: string;
  timestamp?: number;
  images?: ImageRef[];
  files?: FileRef[];
}

export type AssistantBlock =
  | {type: 'text'; text: string}
  | {type: 'thinking'; text: string}
  | {type: 'reasoning'; text: string}
  | {type: 'tool'; tool: ToolCallBlock}
  | {type: 'image'; image: ImageRef}
  | {type: 'file'; file: FileRef}
  | {type: 'error'; text: string};

export interface ToolCallBlock {
  toolId: string;
  name: string;
  /** 80 字预览（服务端 context 字段） */
  context?: string;
  args?: Record<string, unknown>;
  status: 'running' | 'done' | 'error';
  result?: string;
  summary?: string;
  durationS?: number;
  inlineDiff?: string;
  /** tool.progress 的最新进度文本 */
  progress?: string;
}

export interface AssistantMsg {
  kind: 'assistant';
  id: string;
  blocks: AssistantBlock[];
  /** 流式进行中（message.start 之后、message.complete 之前） */
  streaming: boolean;
  timestamp?: number;
}

export interface ApprovalCardItem {
  kind: 'approval';
  id: string;
  requestId: string;
  command?: string;
  description?: string;
  choices: ApprovalChoice[];
  /** 用户点选后记录，卡片随即移除/标记 */
  resolved?: ApprovalChoice;
  /** approval.expire：服务端已超时，迟到应答会返回 expired */
  expired?: boolean;
}

/** clarify 卡片：agent 主动向用户提问（单问或批量）。 */
export interface ClarifyCardItem {
  kind: 'clarify';
  id: string;
  requestId: string;
  questions: ClarifyQuestion[];
  /** 已应答的 qid（批量逐题作答；单问题固定用 '' 作 key） */
  answeredQids: string[];
  expired?: boolean;
}

export interface SystemEvent {
  kind: 'system';
  id: string;
  /** status.update 的 kind（status/process/compacting/lifecycle/loop…）或自定义 */
  eventKind: string;
  text: string;
}

export type TimelineItem =
  | UserMsg
  | AssistantMsg
  | ApprovalCardItem
  | ClarifyCardItem
  | SystemEvent;
