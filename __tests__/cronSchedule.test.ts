/**
 * cronSchedule 纯逻辑测试：
 * - buildScheduleString：六模式构建 + 字段不完整返回 null
 * - parseSchedule：结构化 schedule / display 字符串回显（含 6 字段表达式秒域丢弃）
 * - describeSchedule / describeRepeat：人性化中文与回退
 * - formatDateTime / toLocalInputValue：本地时间格式化
 */

import type {CronSchedule} from '../src/rpc/types';
import {
  DEFAULT_SCHEDULE_FIELDS,
  buildScheduleString,
  describeRepeat,
  describeSchedule,
  formatDateTime,
  parseSchedule,
  toLocalInputValue,
} from '../src/utils/cronSchedule';

function fields(over: Partial<typeof DEFAULT_SCHEDULE_FIELDS> = {}) {
  return {...DEFAULT_SCHEDULE_FIELDS, ...over};
}

describe('buildScheduleString', () => {
  it('interval：每 N 分钟/小时/天', () => {
    expect(buildScheduleString('interval', fields({intervalCount: 30}))).toBe('every 30m');
    expect(buildScheduleString('interval', fields({intervalCount: 2, intervalUnit: 'h'}))).toBe('every 2h');
    expect(buildScheduleString('interval', fields({intervalCount: 1, intervalUnit: 'd'}))).toBe('every 1d');
    expect(buildScheduleString('interval', fields({intervalCount: 0}))).toBeNull();
  });

  it('daily / weekly / monthly：cron 表达式', () => {
    expect(buildScheduleString('daily', fields({hour: 9, minute: 5}))).toBe('5 9 * * *');
    expect(
      buildScheduleString('weekly', fields({hour: 14, minute: 30, weekdays: [3, 1]})),
    ).toBe('30 14 * * 1,3');
    expect(buildScheduleString('weekly', fields({weekdays: []}))).toBeNull();
    expect(buildScheduleString('monthly', fields({hour: 7, minute: 0, monthDay: 15}))).toBe(
      '0 7 15 * *',
    );
  });

  it('once：datetime-local 值补秒；空值返回 null', () => {
    expect(buildScheduleString('once', fields({onceIso: '2026-02-03T14:00'}))).toBe(
      '2026-02-03T14:00:00',
    );
    expect(buildScheduleString('once', fields({onceIso: ''}))).toBeNull();
  });

  it('custom：原文；空白返回 null', () => {
    expect(buildScheduleString('custom', fields({customExpr: ' 0 9 * * 1-5 '}))).toBe(
      '0 9 * * 1-5',
    );
    expect(buildScheduleString('custom', fields({customExpr: '   '}))).toBeNull();
  });
});

describe('parseSchedule', () => {
  it('结构化 interval：分钟整除归一为小时/天', () => {
    const s: CronSchedule = {kind: 'interval', minutes: 120};
    expect(parseSchedule({schedule: s}).mode).toBe('interval');
    expect(parseSchedule({schedule: s}).fields.intervalUnit).toBe('h');
    const d: CronSchedule = {kind: 'interval', minutes: 1440};
    expect(parseSchedule({schedule: d}).fields.intervalUnit).toBe('d');
  });

  it('结构化 once：run_at 转本地输入值', () => {
    const s: CronSchedule = {kind: 'once', run_at: '2026-02-03T14:00:00'};
    const out = parseSchedule({schedule: s});
    expect(out.mode).toBe('once');
    expect(out.fields.onceIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it('cron 表达式（display 字符串）：daily/weekly/monthly 回显', () => {
    expect(parseSchedule({schedule_display: '0 9 * * *'})).toEqual({
      mode: 'daily',
      fields: expect.objectContaining({hour: 9, minute: 0}),
    });
    const weekly = parseSchedule({schedule_display: '30 14 * * 1,3,5'});
    expect(weekly.mode).toBe('weekly');
    expect(weekly.fields.weekdays).toEqual([1, 3, 5]);
    const monthly = parseSchedule({schedule_display: '0 7 15 * *'});
    expect(monthly.mode).toBe('monthly');
    expect(monthly.fields.monthDay).toBe(15);
  });

  it('6 字段表达式丢弃秒域；识别不了落 custom 保留原文', () => {
    expect(parseSchedule({schedule_display: '0 30 14 * * 1-5'}).mode).toBe('weekly');
    const custom = parseSchedule({schedule_display: '0 18 * * dec'});
    expect(custom.mode).toBe('custom');
    expect(custom.fields.customExpr).toBe('0 18 * * dec');
  });
});

describe('describeSchedule', () => {
  it('interval 中文描述', () => {
    expect(describeSchedule({schedule: {kind: 'interval', minutes: 30}})).toBe('每 30 分钟');
    expect(describeSchedule({schedule: {kind: 'interval', minutes: 120}})).toBe('每 2 小时');
    expect(describeSchedule({schedule: {kind: 'interval', minutes: 1440}})).toBe('每 1 天');
  });

  it('cron 表达式中文描述', () => {
    expect(describeSchedule({schedule: {kind: 'cron', expr: '0 9 * * *'}})).toBe('每天 09:00');
    expect(describeSchedule({schedule: {kind: 'cron', expr: '30 14 * * 1,3,5'}})).toBe(
      '每周一、三、五 14:30',
    );
    expect(describeSchedule({schedule: {kind: 'cron', expr: '0 7 1 * *'}})).toBe('每月1日 07:00');
  });

  it('无法识别回退 display/原文；空返回 —', () => {
    expect(describeSchedule({schedule_display: '0 18 * * dec'})).toBe('0 18 * * dec');
    expect(describeSchedule({})).toBe('—');
  });
});

describe('describeRepeat', () => {
  it('永久 / 一次性 / N 次 / 已完成', () => {
    expect(describeRepeat(undefined)).toBe('永久');
    expect(describeRepeat({times: null, completed: 3})).toBe('永久');
    expect(describeRepeat({times: 1, completed: 0})).toBe('一次性');
    expect(describeRepeat({times: 5, completed: 2})).toBe('5 次');
    expect(describeRepeat({times: 5, completed: 5})).toBe('已完成 5/5');
  });
});

describe('formatDateTime / toLocalInputValue', () => {
  it('ISO → M/D HH:mm；空/无效返回 —', () => {
    const d = new Date();
    const out = formatDateTime(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T09:05:00`,
    );
    expect(out).toBe(`${d.getMonth() + 1}/${d.getDate()} 09:05`);
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
  });

  it('toLocalInputValue：ISO → datetime-local 值且往返一致', () => {
    const v = toLocalInputValue('2026-02-03T14:00:00');
    expect(v).toMatch(/^\d{4}-02-03T\d{2}:\d{2}$/);
    expect(toLocalInputValue('bad')).toBe('');
  });
});
