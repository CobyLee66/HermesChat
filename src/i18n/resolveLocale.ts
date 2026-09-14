/**
 * resolveLocale — BCP47 语言标签归一到支持的语言。
 * 顺序：精确匹配 → 主子标签匹配（zh* 归入 zh-CN，en* 归入 en）→ 兜底 en
 * （不支持的语言默认回退英文，中文变体 zh-TW/zh-HK 归入 zh-CN）。
 */
export const SUPPORTED_LOCALES = ['zh-CN', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export function resolveLocale(tag: string | undefined | null): Locale {
  if (!tag) {
    return 'en';
  }
  const normalized = tag.replace(/_/g, '-').toLowerCase();
  const exact = SUPPORTED_LOCALES.find(l => l.toLowerCase() === normalized);
  if (exact) {
    return exact;
  }
  const primary = normalized.split('-')[0];
  if (primary === 'zh') {
    return 'zh-CN';
  }
  return 'en';
}
