/**
 * react-native-fs 的 jest mock（真实模块 import 时会访问 NativeModules 崩掉）。
 * 用内存 Set 模拟文件系统：writeFile/exists/unlink/stat 联动，供头像缓存等用例使用。
 */
const files = new Set<string>();

export default {
  CachesDirectoryPath: '/tmp/caches',
  DocumentDirectoryPath: '/tmp/docs',
  readFile: jest.fn(async (_path: string, _enc?: string) => 'aGk='),
  writeFile: jest.fn(async (path: string, _content: string, _enc?: string) => {
    files.add(path);
  }),
  unlink: jest.fn(async (path: string) => {
    files.delete(path);
  }),
  exists: jest.fn(async (path: string) => files.has(path)),
  mkdir: jest.fn(async () => {}),
  stat: jest.fn(async (path: string) => ({
    path,
    size: 42,
    toJSON: () => ({path, size: 42}),
  })),
  /** 清空模拟文件系统（测试 beforeEach 用） */
  __resetFiles: () => files.clear(),
};
