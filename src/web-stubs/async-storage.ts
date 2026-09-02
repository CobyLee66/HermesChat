/**
 * web 打桩：@react-native-async-storage/async-storage（vite alias，仅 web 构建使用）。
 * 以 localStorage 实现 getItem/setItem/removeItem（同步转 Promise）。
 */

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storage(): StorageLike {
  const s = (globalThis as {localStorage?: StorageLike}).localStorage;
  if (!s) {
    throw new Error('localStorage 不可用（非浏览器环境？）');
  }
  return s;
}

const AsyncStorage = {
  async getItem(key: string): Promise<string | null> {
    return storage().getItem(key);
  },
  async setItem(key: string, value: string): Promise<void> {
    storage().setItem(key, value);
  },
  async removeItem(key: string): Promise<void> {
    storage().removeItem(key);
  },
};

export default AsyncStorage;
