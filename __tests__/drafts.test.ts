/**
 * drafts store：输入框草稿按会话 key 存取、迁移、清理与 AsyncStorage 持久化。
 * 背景：草稿原先是组件内 useState，重连 sid 迁移（navigation.replace 重建
 * 页面）、返回重进、进程被杀都会清零；此 store 是「各种情况不丢」的落点。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  _flushDraftsForTests,
  _resetDraftsForTests,
  useDraftStore,
} from '../src/store/drafts';

const STORAGE_KEY = 'hermes.drafts.v1';

async function persistedRaw(): Promise<string | null> {
  // setItem 是 async mock，flush 后等一拍微任务确保落盘完成
  await Promise.resolve();
  return AsyncStorage.getItem(STORAGE_KEY);
}

beforeEach(async () => {
  _resetDraftsForTests();
  await AsyncStorage.clear();
  jest.clearAllMocks();
});

describe('drafts store 存取', () => {
  it('setDraft 写入；空串清除该 key（不留空条目）', () => {
    const {setDraft} = useDraftStore.getState();
    setDraft('sid1', '你好');
    expect(useDraftStore.getState().drafts.sid1).toBe('你好');

    setDraft('sid1', '');
    expect(useDraftStore.getState().drafts).not.toHaveProperty('sid1');
    // 对不存在的 key 再清一次：不产生 state 变更
    const before = useDraftStore.getState().drafts;
    setDraft('sidX', '');
    expect(useDraftStore.getState().drafts).toBe(before);
  });

  it('migrateDraft：非空草稿搬到新 key 并删旧 key', () => {
    const {setDraft, migrateDraft} = useDraftStore.getState();
    setDraft('oldSid', '写到一半');
    migrateDraft('oldSid', 'newSid');
    const {drafts} = useDraftStore.getState();
    expect(drafts.newSid).toBe('写到一半');
    expect(drafts).not.toHaveProperty('oldSid');
  });

  it('migrateDraft：旧 key 无草稿 / 同 key 时不动', () => {
    const {setDraft, migrateDraft} = useDraftStore.getState();
    setDraft('a', '保留');
    migrateDraft('missing', 'b');
    expect(useDraftStore.getState().drafts).toEqual({a: '保留'});
    migrateDraft('a', 'a');
    expect(useDraftStore.getState().drafts).toEqual({a: '保留'});
  });

  it('pruneDrafts：批量清理（删除会话场景）', () => {
    const {setDraft, pruneDrafts} = useDraftStore.getState();
    setDraft('live1', 'x');
    setDraft('stored1', 'y');
    setDraft('keep', 'z');
    pruneDrafts(['live1', 'stored1', 'missing']);
    expect(useDraftStore.getState().drafts).toEqual({keep: 'z'});
  });

  it('LRU：超过 200 条淘汰最旧触碰', () => {
    const {setDraft} = useDraftStore.getState();
    for (let i = 0; i < 210; i++) {
      setDraft(`sid${i}`, `t${i}`);
    }
    const {drafts} = useDraftStore.getState();
    expect(Object.keys(drafts)).toHaveLength(200);
    expect(drafts).not.toHaveProperty('sid0');
    expect(drafts).not.toHaveProperty('sid9');
    expect(drafts.sid10).toBe('t10');
    expect(drafts.sid209).toBe('t209');
  });

  it('LRU：重新触碰可保活旧 key', () => {
    const {setDraft} = useDraftStore.getState();
    for (let i = 0; i < 200; i++) {
      setDraft(`sid${i}`, `t${i}`);
    }
    setDraft('sid0', '重写'); // 触碰最旧 key
    setDraft('new1', 'n1'); // 应淘汰 sid1 而非 sid0
    const {drafts} = useDraftStore.getState();
    expect(drafts.sid0).toBe('重写');
    expect(drafts).not.toHaveProperty('sid1');
  });
});

describe('drafts store 持久化', () => {
  it('防抖落盘：setDraft 后不立即写，flush 后写入整表', async () => {
    jest.useFakeTimers();
    try {
      const {setDraft} = useDraftStore.getState();
      setDraft('sid1', '草稿');
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      jest.advanceTimersByTime(300);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        STORAGE_KEY,
        JSON.stringify({sid1: '草稿'}),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('loadPersisted：启动恢复（空串/非字符串条目被过滤）', async () => {
    await AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({sid1: '回来', bad: 42, empty: ''}),
    );
    await useDraftStore.getState().loadPersisted();
    expect(useDraftStore.getState().drafts).toEqual({sid1: '回来'});
  });

  it('loadPersisted：损坏 JSON 视为空，不抛错', async () => {
    await AsyncStorage.setItem(STORAGE_KEY, '{oops');
    await expect(
      useDraftStore.getState().loadPersisted(),
    ).resolves.toBeUndefined();
    expect(useDraftStore.getState().drafts).toEqual({});
  });

  it('迁移/清理同样落盘', async () => {
    const {setDraft, migrateDraft, pruneDrafts} = useDraftStore.getState();
    setDraft('a', 'x');
    migrateDraft('a', 'b');
    _flushDraftsForTests();
    expect(await persistedRaw()).toBe(JSON.stringify({b: 'x'}));

    pruneDrafts(['b']);
    _flushDraftsForTests();
    expect(await persistedRaw()).toBe(JSON.stringify({}));
  });
});
