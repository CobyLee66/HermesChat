/** AsyncStorage 的内存 mock（v3 不再自带 jest mock）。 */
const store = new Map<string, string>();

export default {
  getItem: jest.fn(async (key: string) => store.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
  removeItem: jest.fn(async (key: string) => {
    store.delete(key);
  }),
  clear: jest.fn(async () => store.clear()),
  getAllKeys: jest.fn(async () => [...store.keys()]),
  _dump: () => Object.fromEntries(store),
};
