/**
 * 后台进程通知的文本形状识别（纯函数）。
 *
 * 服务端 tools/process_registry_notifications.py `format_process_notification()`
 * 产出 `[IMPORTANT: …]` 信封文本，tui_gateway 的通知 poller 把它当 prompt 提交、
 * 落库成 role=user 行。两条投递链的**声明情况不同**（2026-10-25 只读探查服务端
 * 0.22.5 源码确认）：
 * - **批量完成（≥2 条）带声明**：`ProcessNotificationBatch.render()` 产出
 *   `[IMPORTANT: {n} background processes completed. …` 头部 + 各条通知；
 *   `tui_gateway/session_notifications.py _notif_dispatch_completions()` 提交时
 *   **带** `display_kind="process_complete"` + `display_metadata.display_text`。
 *   messaging gateway 另有 `_format_coalesced_process_completions()` 的
 *   `[IMPORTANT: {n} background processes completed for this session.` 措辞
 *   （同一前缀族）。
 * - **单条完成不带声明**：`_notif_dispatch_event()` 当普通 prompt 提交、
 *   **不传 display_kind**（只有 async_delegation / heartbeat 打标），落库行
 *   role=user 且无声明，客户端只能按形状识别。
 *
 * 因此本模块只回答「这段正文是不是进程通知」：声明式 display_kind 由聚合器
 * 优先消费（`process_complete` 分支），本模块的形状白名单兜底无声明行，
 * 同时给声明行做正文二次判定（批量头 → 计数标签）。
 *
 * ⚠ 前缀必须白名单化，不能放宽成「任何 `[IMPORTANT: ` 开头」：cron 任务
 * 提示词（`[IMPORTANT: You are running as a scheduled cron job. …]`）与 skill
 * 注入提示词（`[IMPORTANT: The user has invoked the "…" skill …]`）共用同一
 * 信封前缀，宽口径会把整段任务提示词（数百字~10KB）压成一行灰条。
 * 正文形状另见官方 desktop 的 PROCESS_NOTIFICATION_RE（只收 Background
 * process 一种且要求整条以 `]` 收尾）。
 */

/**
 * 通知正文前缀家族（= format_process_notification 的三种产出形态）：
 * - `Background process `：完成回执（completed/exited/terminated/lost/failed
 *   to start）与 watch_match；
 * - `Watch patterns disabled for process `：watch 因限流/达上限被关闭（单行）；
 * - `Watch-pattern `：全局熔断触发 / 恢复（单行）。
 *
 * 不锚定结尾的 `]`：服务端未来给正文加后缀或截断时仍应识别；正文中间出现
 * `]`、换行、嵌套 `[IMPORTANT:` 均不影响（只看开头前缀）。
 */
const PROCESS_NOTIFICATION_PREFIXES = [
  '[IMPORTANT: Background process ',
  '[IMPORTANT: Watch patterns disabled for process ',
  '[IMPORTANT: Watch-pattern ',
];

/**
 * 批量完成通知头（= ProcessNotificationBatch.render 与 gateway coalesced 的
 * 两种措辞）：`[IMPORTANT: {n} background processes completed…`。
 *
 * 数字必须紧贴 `background process`——cron 任务提示词、skill 注入、正文中部
 * 提及都不以「数字 + background process」开头，天然被挡在门外。
 * 不锚定收尾：批量头以 `.` 结尾（所有通知的收尾 `]` 在最后一条末尾）。
 */
const BATCH_HEADER_RE =
  /^\[IMPORTANT: (\d+) background process(?:es)? (?:completed|finished)\b/;

/** 灰条标签最大字符数（对齐官方 desktop timelinePreview 的 120）：
 * `Watch patterns disabled for process …` 单行原文约 230 字符，手机端会折
 * 4 行；proc id / 退出码都在首行前段，截断不丢关键信息，全文在展开层。 */
const HEADLINE_MAX = 120;

/**
 * 批量完成通知的进程条数（非批量头返回 null）。服务端 `_live()` 在渲染时按
 * 未消费计数，批量恒 ≥2（单条走单条措辞），这里只做防御性 >0 校验。
 * 灰条标签用它做 i18n 计数标签——批量头正文是给模型的指令（"Treat these
 * results as one batch…"），不适合直接展示。
 */
export function processNotificationBatchCount(text: string): number | null {
  const match = BATCH_HEADER_RE.exec(text.trimStart());
  if (!match) {
    return null;
  }
  const count = Number.parseInt(match[1], 10);
  return Number.isFinite(count) && count > 0 ? count : null;
}

/** 是否进程通知行（时间线系统灰条）：批量完成头或单条通知前缀家族。 */
export function isProcessNotificationText(text: string): boolean {
  if (processNotificationBatchCount(text) !== null) {
    return true;
  }
  const head = text.trimStart();
  return PROCESS_NOTIFICATION_PREFIXES.some(prefix => head.startsWith(prefix));
}

/**
 * 通知首行作为灰条标签：剥 `[IMPORTANT: ` 信封 → 剥收尾 `]`（单行通知的
 * 收尾符；多行通知的收尾符在末行，不影响首行）→ 取首行 → 空白压平 →
 * 超长截断。正文原样保留在 SystemEvent.fullText 供点击展开。
 */
export function processNotificationHeadline(text: string): string {
  const body = text.trim().replace(/^\[IMPORTANT:\s*/, '').replace(/\]$/, '');
  const firstLine = (body.split('\n', 1)[0] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (firstLine.length <= HEADLINE_MAX) {
    return firstLine;
  }
  return firstLine.slice(0, HEADLINE_MAX).trimEnd() + '…';
}
