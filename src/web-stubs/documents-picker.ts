/**
 * web 打桩：@react-native-documents/picker（vite alias，仅 web 构建使用）。
 * 系统文档选择器在浏览器中不可用：pick/keepLocalCopy 一律 reject，
 * 导出表面覆盖 App 当前消费面（pick/keepLocalCopy/types/errorCodes/isErrorWithCode）。
 */

export const types = {
  allFiles: 'public.item',
  images: 'public.image',
  plainText: 'public.plain-text',
  audio: 'public.audio',
  pdf: 'com.adobe.pdf',
} as const;

export const errorCodes = {
  OPERATION_CANCELED: 'OPERATION_CANCELED',
  IN_PROGRESS: 'ASYNC_OP_IN_PROGRESS',
  UNABLE_TO_OPEN_FILE_TYPE: 'UNABLE_TO_OPEN_FILE_TYPE',
} as const;

export function isErrorWithCode(err: unknown): err is {code: string} {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as {code?: unknown}).code === 'string'
  );
}

function unavailable(method: string): Promise<never> {
  return Promise.reject(
    new Error(`系统文件选择器在浏览器中不可用（${method}）`),
  );
}

export function pick(): Promise<never> {
  return unavailable('pick');
}

export function keepLocalCopy(): Promise<never> {
  return unavailable('keepLocalCopy');
}
