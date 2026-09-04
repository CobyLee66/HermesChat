/**
 * 会话来源分类测试（对齐 dashboard 的过滤口径）：
 * - 自动化 source 集合判定（含大小写/空白容错）
 * - 三档过滤（聊天/自动化/全部）的归属
 * - 自动化徽标文案
 */

import {
  automationSourceLabel,
  isAutomationSource,
  sourceBelongsToCategory,
} from '../src/utils/sessionSources';

describe('isAutomationSource', () => {
  it('dashboard 定义的自动化来源返回 true', () => {
    for (const s of [
      'cron',
      'tool',
      'api_server',
      'acp',
      'hermes_flow',
      'vulcan_delegate',
      'webhook',
    ]) {
      expect(isAutomationSource(s)).toBe(true);
    }
  });

  it('普通聊天来源返回 false', () => {
    for (const s of ['tui', 'cli', 'qqbot', 'telegram', 'subagent', '']) {
      expect(isAutomationSource(s)).toBe(false);
    }
  });

  it('大小写与首尾空白容错，空值安全', () => {
    expect(isAutomationSource(' CRON ')).toBe(true);
    expect(isAutomationSource('Cron')).toBe(true);
    expect(isAutomationSource(undefined as unknown as string)).toBe(false);
  });
});

describe('sourceBelongsToCategory', () => {
  it('全部 → 一律 true', () => {
    expect(sourceBelongsToCategory('cron', 'all')).toBe(true);
    expect(sourceBelongsToCategory('tui', 'all')).toBe(true);
  });

  it('自动化 → 仅自动化来源', () => {
    expect(sourceBelongsToCategory('cron', 'automation')).toBe(true);
    expect(sourceBelongsToCategory('tui', 'automation')).toBe(false);
  });

  it('聊天 → 仅非自动化来源', () => {
    expect(sourceBelongsToCategory('tui', 'chats')).toBe(true);
    expect(sourceBelongsToCategory('qqbot', 'chats')).toBe(true);
    expect(sourceBelongsToCategory('cron', 'chats')).toBe(false);
  });
});

describe('automationSourceLabel', () => {
  it('已知来源给短文案，未知来源小写兜底', () => {
    expect(automationSourceLabel('cron')).toBe('Cron');
    expect(automationSourceLabel('api_server')).toBe('API');
    expect(automationSourceLabel('some_new')).toBe('some_new');
  });
});
