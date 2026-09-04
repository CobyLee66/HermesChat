/**
 * 会话来源分类（对齐 hermes web dashboard 的会话过滤口径）。
 *
 * `session.list` 每行带 `source`（写入端打的平台标签：tui/cli/qqbot/cron…）。
 * dashboard（web/src/pages/SessionsPage.tsx 的 AUTOMATION_SESSION_SOURCES）
 * 把 cron/tool/api_server/acp/hermes_flow/vulcan_delegate/webhook 视为
 * 「自动化」会话，其余（tui/cli/telegram/discord/qqbot/subagent…）为普通
 * 聊天。App 自建会话经 tui_gateway 默认打 `tui`（server.py
 * _resolve_session_platform），落在「聊天」类，不会被误滤。
 */

export type SessionFilterCategory = 'chats' | 'automation' | 'all';

/** 与 dashboard 的 AUTOMATION_SESSION_SOURCES 保持一致 */
const AUTOMATION_SOURCES: ReadonlySet<string> = new Set([
  'cron',
  'tool',
  'api_server',
  'acp',
  'hermes_flow',
  'vulcan_delegate',
  'webhook',
]);

/** 自动化行的来源徽标文案（未识别的 source 原样小写兜底） */
const SOURCE_LABELS: Record<string, string> = {
  cron: 'Cron',
  tool: 'Tool',
  api_server: 'API',
  acp: 'ACP',
  hermes_flow: 'Flow',
  vulcan_delegate: 'Delegate',
  webhook: 'Webhook',
};

export function isAutomationSource(source: string): boolean {
  return AUTOMATION_SOURCES.has((source || '').trim().toLowerCase());
}

export function sourceBelongsToCategory(
  source: string,
  category: SessionFilterCategory,
): boolean {
  if (category === 'all') {
    return true;
  }
  if (category === 'automation') {
    return isAutomationSource(source);
  }
  return !isAutomationSource(source);
}

export function automationSourceLabel(source: string): string {
  const key = (source || '').trim().toLowerCase();
  return SOURCE_LABELS[key] ?? key;
}
