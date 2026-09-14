/**
 * deviceLocale — web/桌面端系统语言检测（vite 构建经 `.web.ts` 优先解析进 web 包，
 * 原生 Metro 构建不会拉本文件）。浏览器全局用结构类型断言取用（项目无 DOM lib，
 * 循 clipboard.ts 先例）。
 */
export function detectSystemLocale(): string | undefined {
  const nav = (globalThis as {
    navigator?: {languages?: readonly string[]; language?: string};
  }).navigator;
  return nav?.languages?.[0] || nav?.language || undefined;
}
