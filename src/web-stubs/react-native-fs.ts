/**
 * web 打桩：react-native-fs（vite alias，仅 web 构建使用）。
 * 浏览器无沙盒文件系统：方法一律 reject，调用方均有 catch 兜底。
 */

function unavailable(method: string): Promise<never> {
  return Promise.reject(
    new Error(`react-native-fs 在浏览器中不可用（${method}）`),
  );
}

const RNFS = {
  CachesDirectoryPath: '/web-stub/caches',
  DocumentDirectoryPath: '/web-stub/documents',
  TemporaryDirectoryPath: '/web-stub/tmp',
  readFile: (_path: string, _encoding?: string): Promise<string> =>
    unavailable('readFile'),
  writeFile: (_path: string, _content: string, _encoding?: string) =>
    unavailable('writeFile'),
  unlink: (_path: string): Promise<void> => unavailable('unlink'),
  exists: (_path: string): Promise<boolean> => Promise.resolve(false),
  mkdir: (_path: string): Promise<void> => unavailable('mkdir'),
  stat: (_path: string) => unavailable('stat'),
};

export default RNFS;
