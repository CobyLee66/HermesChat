/**
 * 后台进程通知文本形状识别（utils/processNotification）纯函数测试：
 * - 前缀家族白名单命中三种服务端产出形态（完成回执 / watch 关闭 / watch 熔断）
 * - 宽口径反例：cron 任务提示词、skill 注入、正文中部提及一律不命中
 * - 灰条标签：剥 [IMPORTANT: 信封与收尾 ]、取首行、空白压平、超长截断
 */

import {
  isProcessNotificationText,
  processNotificationHeadline,
} from '../src/utils/processNotification';

const COMPLETION =
  '[IMPORTANT: Background process proc_deadbeef1234 completed normally ' +
  '(exit code 0).\nCommand: npm run build\nOutput:\nbuild ok]';
const WATCH_MATCH =
  '[IMPORTANT: Background process proc_deadbeef1234 matched watch pattern ' +
  '"ERROR".\nCommand: tail -f app.log\nMatched output:\nERROR boom]';
const WATCH_DISABLED =
  '[IMPORTANT: Watch patterns disabled for process proc_deadbeef1234 — ' +
  '5 consecutive rate-limit windows triggered (min spacing 30s).]';
const WATCH_OVERFLOW =
  '[IMPORTANT: Watch-pattern overflow: >30 notifications in 60s across all ' +
  'processes. Suppressing further watch_match events for 300s.]';

describe('isProcessNotificationText（前缀家族白名单）', () => {
  it('命中三种通知形态（含首部空白）', () => {
    expect(isProcessNotificationText(COMPLETION)).toBe(true);
    expect(isProcessNotificationText(WATCH_MATCH)).toBe(true);
    expect(isProcessNotificationText(WATCH_DISABLED)).toBe(true);
    expect(isProcessNotificationText(WATCH_OVERFLOW)).toBe(true);
    expect(isProcessNotificationText(`\n  ${COMPLETION}`)).toBe(true);
  });

  it('不命中 cron 任务提示词 / skill 注入（同 [IMPORTANT: 信封前缀）', () => {
    expect(
      isProcessNotificationText(
        '[IMPORTANT: You are running as a scheduled cron job. DELIVERY: Your ' +
          'final response will be automatically delivered.]',
      ),
    ).toBe(false);
    expect(
      isProcessNotificationText(
        '[IMPORTANT: The user has invoked the "demo-skill" skill, indicating ' +
          'they want you to follow its instructions.]',
      ),
    ).toBe(false);
  });

  it('不命中正文中部提及 / 近似前缀 / 空文本', () => {
    expect(isProcessNotificationText(`看这条：${COMPLETION}`)).toBe(false);
    expect(
      isProcessNotificationText('[IMPORTANT: Background processes finished]'),
    ).toBe(false);
    expect(isProcessNotificationText('[IMPORTANT: ]')).toBe(false);
    expect(isProcessNotificationText('')).toBe(false);
    expect(isProcessNotificationText('   ')).toBe(false);
    expect(isProcessNotificationText('普通消息 [IMPORTANT: Background process x]')).toBe(
      false,
    );
  });
});

describe('processNotificationHeadline（灰条标签）', () => {
  it('多行通知取首行并剥信封（收尾 ] 在末行，不影响首行）', () => {
    expect(processNotificationHeadline(COMPLETION)).toBe(
      'Background process proc_deadbeef1234 completed normally (exit code 0).',
    );
    expect(processNotificationHeadline(WATCH_MATCH)).toBe(
      'Background process proc_deadbeef1234 matched watch pattern "ERROR".',
    );
  });

  it('单行通知剥掉收尾 ]，空白压平', () => {
    const out = processNotificationHeadline(WATCH_DISABLED);
    expect(out.startsWith('Watch patterns disabled for process')).toBe(true);
    expect(out.endsWith(']')).toBe(false);
    expect(out.includes('\n')).toBe(false);
    expect(processNotificationHeadline(`  ${WATCH_OVERFLOW}  `)).toBe(
      'Watch-pattern overflow: >30 notifications in 60s across all processes. ' +
        'Suppressing further watch_match events for 300s.',
    );
  });

  it('首行超长截断到 120 字符加省略号', () => {
    const long = `[IMPORTANT: Background process proc_x ${'a'.repeat(200)}]`;
    const out = processNotificationHeadline(long);
    expect(out.length).toBe(121);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('Background process proc_x')).toBe(true);
  });

  it('嵌入换行/制表符的首行压平成单行', () => {
    expect(
      processNotificationHeadline('[IMPORTANT: Background process p1\t  done\nCommand: x]'),
    ).toBe('Background process p1 done');
  });
});
