/** react-native-fs 的 jest mock（真实模块 import 时会访问 NativeModules 崩掉）。 */
export default {
  CachesDirectoryPath: '/tmp/caches',
  DocumentDirectoryPath: '/tmp/docs',
  readFile: jest.fn(async (_path: string, _enc?: string) => 'aGk='),
  unlink: jest.fn(async () => {}),
  exists: jest.fn(async () => true),
  mkdir: jest.fn(async () => {}),
};
