/**
 * interpolate — 词典占位符插值。
 * 模板形如 '发送失败：{message}'，params 提供同名值；缺参保留占位符便于发现问题。
 */
import type {MessageParams} from './locales/en';

export function interpolate(template: string, params?: MessageParams): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}
