/**
 * ChatHeaderTitle — 聊天顶栏标题：会话标题 + 模型/上下文/思考等级小字副标题。
 * 订阅 chat store，随 usage 事件自动刷新。手机原生 header 与桌面聊天列头共用。
 */

import React from 'react';

import {HeaderTitleView} from './HeaderTitle';
import {useChatStore} from '../store/chat';

/** token 数简写：999 → 999，1234 → 1.2k，45230 → 45.2k，200000 → 200k */
export function formatTokens(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  const k = n / 1000;
  const v = k >= 100 ? Math.round(k) : Math.round(k * 10) / 10;
  return `${v}k`;
}

export const ChatHeaderTitle = React.memo(function ChatHeaderTitle({
  sessionId,
  title,
}: {
  sessionId: string;
  title: string;
}) {
  const info = useChatStore(s => s.bySession[sessionId]?.info);
  const used = info?.usage?.context_used;
  const max = info?.usage?.context_max;
  const parts: string[] = [];
  if (info?.model) {
    parts.push(info.model);
  }
  if (typeof used === 'number' && typeof max === 'number' && max > 0) {
    parts.push(`${formatTokens(used)}/${formatTokens(max)}`);
  }
  // 服务端口径：""=未设置（供应商默认，不展示）、其余等级原文直接展示
  // （none=已关闭、low/medium/high/xhigh/max/ultra…）
  const effort = info?.reasoning_effort;
  if (effort) {
    parts.push(effort);
  }
  const subtitle = parts.length > 0 ? parts.join(' · ') : null;
  return <HeaderTitleView title={title} subtitle={subtitle} />;
});
