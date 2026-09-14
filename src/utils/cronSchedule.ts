/**
 * cronSchedule — 定时任务 schedule 的纯逻辑（无 RN 依赖，可 jest 直测）。
 *
 * 六种构建模式 ↔ schedule 字符串（服务端 parse_schedule 语法，
 * 见 hermes-agent/cron/jobs.py）：interval/daily/weekly/monthly/once/custom。
 * 另含人性化描述（经 src/i18n t() 取词，jest 直测时为当前语言）与时间格式化
 * （项目无 dayjs，手写）。
 */

import {t} from '../i18n';
import type {MessageKey} from '../i18n/locales/en';
import type {CronJobRepeat, CronSchedule} from '../rpc/types';

export type ScheduleMode =
  | 'interval'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'once'
  | 'custom';

export const SCHEDULE_MODE_LABELS: {
  key: ScheduleMode;
  labelKey: MessageKey;
}[] = [
  {key: 'interval', labelKey: 'cron.modeInterval'},
  {key: 'daily', labelKey: 'cron.modeDaily'},
  {key: 'weekly', labelKey: 'cron.modeWeekly'},
  {key: 'monthly', labelKey: 'cron.modeMonthly'},
  {key: 'once', labelKey: 'cron.modeOnce'},
  {key: 'custom', labelKey: 'cron.modeCustom'},
];

/** 表单各模式的全部字段（只读当前模式相关的，其余保持默认值即可）。 */
export interface ScheduleFields {
  intervalCount: number;
  intervalUnit: 'm' | 'h' | 'd';
  /** 0-23 */
  hour: number;
  /** 0-59 */
  minute: number;
  /** cron 星期域：0=周日 … 6=周六（可多选） */
  weekdays: number[];
  /** 1-31 */
  monthDay: number;
  /** once 模式：'YYYY-MM-DDTHH:mm'（datetime-local 原生值格式） */
  onceIso: string;
  customExpr: string;
}

export const DEFAULT_SCHEDULE_FIELDS: ScheduleFields = {
  intervalCount: 30,
  intervalUnit: 'm',
  hour: 9,
  minute: 0,
  weekdays: [1],
  monthDay: 1,
  onceIso: '',
  customExpr: '',
};

/** 模式 → schedule 字符串；字段不完整返回 null（表单校验用）。 */
export function buildScheduleString(
  mode: ScheduleMode,
  f: ScheduleFields,
): string | null {
  switch (mode) {
    case 'interval': {
      if (!(f.intervalCount > 0)) {
        return null;
      }
      return `every ${f.intervalCount}${f.intervalUnit}`;
    }
    case 'daily':
      return `${f.minute} ${f.hour} * * *`;
    case 'weekly': {
      if (f.weekdays.length === 0) {
        return null;
      }
      const days = [...f.weekdays].sort((a, b) => a - b).join(',');
      return `${f.minute} ${f.hour} * * ${days}`;
    }
    case 'monthly':
      return `${f.minute} ${f.hour} ${f.monthDay} * *`;
    case 'once': {
      // datetime-local 给 'YYYY-MM-DDTHH:mm'；服务端解析容忍到分钟
      return f.onceIso ? `${f.onceIso}:00` : null;
    }
    case 'custom':
      return f.customExpr.trim() || null;
  }
}

/**
 * 编辑回显：从 job 记录反解 {mode, fields}。优先结构化 schedule（服务端
 * parse_schedule 产物），缺失时回退解析 schedule_display 字符串；
 * 识别不了统一落 custom 模式（原文进表达式框，提交即原样返回）。
 */
export function parseSchedule(job: {
  schedule?: CronSchedule;
  schedule_display?: string;
}): {mode: ScheduleMode; fields: ScheduleFields} {
  const fields = {...DEFAULT_SCHEDULE_FIELDS};
  const s = job.schedule;
  if (s && s.kind === 'interval' && typeof s.minutes === 'number') {
    if (s.minutes % 1440 === 0) {
      fields.intervalCount = s.minutes / 1440;
      fields.intervalUnit = 'd';
    } else if (s.minutes % 60 === 0) {
      fields.intervalCount = s.minutes / 60;
      fields.intervalUnit = 'h';
    } else {
      fields.intervalCount = s.minutes;
      fields.intervalUnit = 'm';
    }
    return {mode: 'interval', fields};
  }
  if (s && s.kind === 'once' && typeof s.run_at === 'string') {
    fields.onceIso = toLocalInputValue(s.run_at);
    return {mode: 'once', fields};
  }
  const raw =
    (s && s.kind === 'cron' && typeof s.expr === 'string' ? s.expr : '') ||
    job.schedule_display ||
    '';
  const parsed = parseCronExpr(raw, fields);
  if (parsed) {
    return {mode: parsed, fields};
  }
  fields.customExpr = raw;
  return {mode: 'custom', fields};
}

/** 5/6 字段表达式 → daily/weekly/monthly 模式；不匹配返回 null。 */
function parseCronExpr(
  raw: string,
  fields: ScheduleFields,
): 'daily' | 'weekly' | 'monthly' | null {
  const parts = raw.trim().split(/\s+/);
  if (parts.length === 6) {
    parts.shift(); // 6 字段首位是秒，丢弃
  }
  if (parts.length !== 5) {
    return null;
  }
  const [m, h, dom, mon, dow] = parts;
  if (!/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(h) || mon !== '*') {
    return null;
  }
  fields.minute = Number(m);
  fields.hour = Number(h);
  if (dom === '*' && dowMatches(dow)) {
    fields.weekdays = expandDow(dow);
    return 'weekly';
  }
  if (dow === '*' && /^\d{1,2}$/.test(dom)) {
    fields.monthDay = Number(dom);
    return 'monthly';
  }
  if (dom === '*' && dow === '*') {
    return 'daily';
  }
  return null;
}

/** cron 星期域：单值/逗号列表/区间（1-5）及其组合。 */
function dowMatches(dow: string): boolean {
  return dow.split(',').every(p => /^\d{1,2}$/.test(p) || /^\d{1,2}-\d{1,2}$/.test(p));
}

function expandDow(dow: string): number[] {
  const out: number[] = [];
  for (const p of dow.split(',')) {
    const range = p.match(/^(\d{1,2})-(\d{1,2})$/);
    if (range) {
      for (let i = Number(range[1]); i <= Number(range[2]); i++) {
        out.push(i);
      }
    } else {
      out.push(Number(p));
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** cron 星期域 → 词典键（0=周日；cron 允许 7=周日，取模归一）。 */
const WEEKDAY_KEYS: MessageKey[] = [
  'cron.weekday0',
  'cron.weekday1',
  'cron.weekday2',
  'cron.weekday3',
  'cron.weekday4',
  'cron.weekday5',
  'cron.weekday6',
];

/** cron 表达式 → 人性化描述（如 `每周一、三 09:30`）；识别不了返回原文。 */
function describeCronExpr(raw: string): string {
  const parts = raw.trim().split(/\s+/);
  if (parts.length === 6) {
    parts.shift();
  }
  if (parts.length !== 5) {
    return raw;
  }
  const [m, h, dom, mon, dow] = parts;
  if (!/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(h) || mon !== '*') {
    return raw;
  }
  const time = `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  if (dom === '*' && dowMatches(dow)) {
    const names = expandDow(dow)
      .map(d => t(WEEKDAY_KEYS[d % 7]))
      .join(t('cron.listSep'));
    return t('cron.everyWeekday', {days: names, time});
  }
  if (dow === '*' && /^\d{1,2}(,\d{1,2})*$/.test(dom)) {
    const days = dom
      .split(',')
      .map(Number)
      .sort((a, b) => a - b)
      .join(t('cron.listSep'));
    return t('cron.monthDays', {days, time});
  }
  if (dom === '*' && dow === '*') {
    return t('cron.dailyTime', {time});
  }
  return raw;
}

/** 任务 schedule 的人性化描述（列表行展示用；识别不了回退 display/原文）。 */
export function describeSchedule(job: {
  schedule?: CronSchedule;
  schedule_display?: string;
}): string {
  const s = job.schedule;
  if (s && s.kind === 'interval' && typeof s.minutes === 'number') {
    if (s.minutes % 1440 === 0) {
      return t('cron.everyDays', {n: s.minutes / 1440});
    }
    if (s.minutes % 60 === 0) {
      return t('cron.everyHours', {n: s.minutes / 60});
    }
    return t('cron.everyMinutes', {n: s.minutes});
  }
  if (s && s.kind === 'once' && typeof s.run_at === 'string') {
    return t('cron.onceAt', {time: formatDateTime(s.run_at)});
  }
  const raw =
    (s && s.kind === 'cron' && typeof s.expr === 'string' ? s.expr : '') ||
    job.schedule_display ||
    '';
  return raw ? describeCronExpr(raw) : '—';
}

/** repeat → 展示文案：永久 / 一次性 / N 次 / 已完成 x/N。 */
export function describeRepeat(repeat?: CronJobRepeat): string {
  if (!repeat || repeat.times == null) {
    return t('cron.repeatForever');
  }
  if (repeat.times <= 1) {
    return t('cron.once');
  }
  return repeat.completed >= repeat.times
    ? t('cron.repeatDone', {done: repeat.completed, total: repeat.times})
    : t('cron.repeatTimes', {count: repeat.times});
}

/** ISO 时间 → 本地 'M/D HH:mm'（跨年补年份）；空/无效返回 '—'。 */
export function formatDateTime(iso?: string | null): string {
  if (!iso) {
    return '—';
  }
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    return '—';
  }
  return formatStamp(d);
}

/** epoch 秒 → 本地 'M/D HH:mm'（跨年补年份）；空返回 '—'。 */
export function formatEpoch(ts?: number | null): string {
  if (!ts) {
    return '—';
  }
  return formatStamp(new Date(ts * 1000));
}

function formatStamp(d: Date): string {
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  const year = d.getFullYear();
  return year === new Date().getFullYear() ? `${md} ${hm}` : `${year}/${md} ${hm}`;
}

/** ISO → datetime-local 输入值 'YYYY-MM-DDTHH:mm'（本地时区）。 */
export function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    return '';
  }
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
