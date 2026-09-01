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
}

// ─── TimelineItem（UI 渲染模型） ────────────────────────────────

export interface UserMsg {
  kind: 'user';
  id: string;
  text: string;
  timestamp?: number;
}

export type AssistantBlock =
  | {type: 'text'; text: string}
  | {type: 'thinking'; text: string}
  | {type: 'reasoning'; text: string}
  | {type: 'tool'; tool: ToolCallBlock}
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
}

export interface SystemEvent {
  kind: 'system';
  id: string;
  /** status.update 的 kind（status/process/compacting/lifecycle/loop…）或自定义 */
  eventKind: string;
  text: string;
}

export type TimelineItem = UserMsg | AssistantMsg | ApprovalCardItem | SystemEvent;
