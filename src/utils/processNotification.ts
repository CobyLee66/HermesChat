/**
 * 后台进程通知的文本形状识别（纯函数）。
 *
 * 服务端 tools/process_registry.py `format_process_notification()` 产出
 * `[IMPORTANT: …]` 信封文本，由 tui_gateway 的通知 poller
 * （server.py `_notification_poller_loop`）当**普通 prompt** 提交
 * （`_run_prompt_submit(rid, sid, session, text)` 不传 display_kind——只有
 * async_delegation 传），因此落库行是 role=user 且**无 display_kind**；
 * 服务端 `_legacy_display_kind` 也只回填 auto_continue。客户端拿不到声明，
 * 只能按文本形状识别，判断为时间线系统灰条而非用户气泡。
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

/** 灰条标签最大字符数（对齐官方 desktop timelinePreview 的 120）：
 * `Watch patterns disabled for process …` 单行原文约 230 字符，手机端会折
 * 4 行；proc id / 退出码都在首行前段，截断不丢关键信息，全文在展开层。 */
const HEADLINE_MAX = 120;

/** 是否是无 display_kind 的进程通知行（时间线系统灰条）。 */
export function isProcessNotificationText(text: string): boolean {
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
