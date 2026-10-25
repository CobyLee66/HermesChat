/**
 * 后台进程通知文本形状识别（utils/processNotification）纯函数测试：
 * - 前缀家族白名单命中三种服务端产出形态（完成回执 / watch 关闭 / watch 熔断）
 * - 批量完成头（≥2 条）识别与条数提取（ProcessNotificationBatch / gateway coalesced）
 * - 宽口径反例：cron 任务提示词、skill 注入、正文中部提及一律不命中
 * - 灰条标签：剥 [IMPORTANT: 信封与收尾 ]、取首行、空白压平、超长截断
 */

import {
  isProcessNotificationText,
  processNotificationBatchCount,
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
/** ProcessNotificationBatch.render() 的批量完成形态：头部 + 各条通知 */
const BATCH_COMPLETION =
  '[IMPORTANT: 2 background processes completed. Treat these results as one ' +
  'batch and give one consolidated response; preserve failures and actionable ' +
  'results.]\n\n' +
  COMPLETION;
/** gateway _format_coalesced_process_completions 的措辞（同一前缀族） */
const BATCH_SESSION =
  '[IMPORTANT: 3 background processes completed for this session.\n' +
  'Treat these results as one completion batch and send at most one ' +
  'consolidated user-facing response.]';

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

describe('批量完成通知（processNotificationBatchCount）', () => {
  it('两种服务端措辞都识别并取到条数', () => {
    expect(processNotificationBatchCount(BATCH_COMPLETION)).toBe(2);
    expect(processNotificationBatchCount(BATCH_SESSION)).toBe(3);
    expect(processNotificationBatchCount(`\n  ${BATCH_COMPLETION}`)).toBe(2);
  });

  it('无句号/无收尾的简写形态仍识别', () => {
    expect(
      processNotificationBatchCount('[IMPORTANT: 2 background processes completed]'),
    ).toBe(2);
  });

  it('非批量头返回 null（单条通知 / cron 提示词 / skill 注入 / 中部提及 / 空）', () => {
    expect(processNotificationBatchCount(COMPLETION)).toBeNull();
    expect(processNotificationBatchCount(WATCH_MATCH)).toBeNull();
    expect(
      processNotificationBatchCount(
        '[IMPORTANT: You are running as a scheduled cron job. DELIVERY: 3 ' +
          'background processes completed will be delivered.]',
      ),
    ).toBeNull();
    expect(
      processNotificationBatchCount(
        '[IMPORTANT: The user has invoked the "demo-skill" skill, indicating ' +
          'they want you to follow its instructions.]',
      ),
    ).toBeNull();
    expect(
      processNotificationBatchCount(`看这条：${BATCH_COMPLETION}`),
    ).toBeNull();
    expect(
      processNotificationBatchCount('[IMPORTANT: Background processes finished]'),
    ).toBeNull();
    expect(processNotificationBatchCount('')).toBeNull();
  });

  it('isProcessNotificationText 把批量头一并算作进程通知', () => {
    expect(isProcessNotificationText(BATCH_COMPLETION)).toBe(true);
    expect(isProcessNotificationText(BATCH_SESSION)).toBe(true);
    expect(
      isProcessNotificationText('[IMPORTANT: 2 background processes completed]'),
    ).toBe(true);
    // 宽口径反例仍不命中
    expect(
      isProcessNotificationText(
        '[IMPORTANT: You are running as a scheduled cron job. DELIVERY: Your ' +
          'final response will be automatically delivered.]',
      ),
    ).toBe(false);
    expect(
      isProcessNotificationText('[IMPORTANT: Background processes finished]'),
    ).toBe(false);
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
