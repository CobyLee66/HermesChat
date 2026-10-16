/**
 * queuedPrompts store：busy（AI 输出中）期间排队的消息，按会话 key 存取、
 * 迁移、清理与 AsyncStorage 持久化。
 * 背景：排队内容必须跨「断线 / 杀进程 / 重进会话」存活，且不能放进 chat store
 * 的投影（attach/reattach 重建会整体覆盖该 key）——独立 store 是唯一落点。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  _flushQueuedPromptsForTests,
  _resetQueuedPromptsForTests,
  queuedKeyFor,
  useQueuedPromptsStore,
} from '../src/store/queuedPrompts';

const STORAGE_KEY = 'hermes.queuedPrompts.v1';

async function persistedRaw(): Promise<string | null> {
  // setItem 是 async mock，flush 后等一拍微任务确保落盘完成
  await Promise.resolve();
  return AsyncStorage.getItem(STORAGE_KEY);
}

function texts(sid: string): string[] {
  return (useQueuedPromptsStore.getState().queues[sid] ?? []).map(it => it.text);
}

beforeEach(async () => {
  _resetQueuedPromptsForTests();
  await AsyncStorage.clear();
  jest.clearAllMocks();
});

describe('queuedPrompts store 存取', () => {
  it('enqueue 尾部追加 FIFO；空文本/纯空白拒绝且不改 state', () => {
    const {enqueue} = useQueuedPromptsStore.getState();
    expect(enqueue('sid1', '第一条')).toBe(true);
    expect(enqueue('sid1', '  ')).toBe(false);
    expect(enqueue('sid1', '第二条')).toBe(true);
    expect(texts('sid1')).toEqual(['第一条', '第二条']);
    // 入队即去首尾空白（发送口径与 sendPrompt 的 trim 一致）
    expect(enqueue('sid1', '  第三条  ')).toBe(true);
    expect(texts('sid1')).toEqual(['第一条', '第二条', '第三条']);
  });

  it('id 唯一：同一毫秒内连续入队也不冲突', () => {
    const {enqueue} = useQueuedPromptsStore.getState();
    const now = 1_700_000_000_000;
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      enqueue('sid1', 'a');
      enqueue('sid1', 'b');
    } finally {
      spy.mockRestore();
    }
    const ids = (useQueuedPromptsStore.getState().queues.sid1 ?? []).map(
      it => it.id,
    );
    expect(new Set(ids).size).toBe(2);
  });

  it('单会话上限 20：超出拒绝入队（调用方提示），已有条目不丢', () => {
    const {enqueue} = useQueuedPromptsStore.getState();
    for (let i = 0; i < 20; i++) {
      expect(enqueue('sid1', `t${i}`)).toBe(true);
    }
    expect(enqueue('sid1', 'overflow')).toBe(false);
    expect(texts('sid1')).toHaveLength(20);
    expect(texts('sid1')[19]).toBe('t19');
    // 另一会话不受影响
    expect(enqueue('sid2', 'ok')).toBe(true);
  });

  it('removeQueued：按 id 出队（跨会话 key 也能命中）；miss 时不动 state', () => {
    const {enqueue, removeQueued} = useQueuedPromptsStore.getState();
    enqueue('sid1', 'A');
    enqueue('sid1', 'B');
    enqueue('sid2', 'C');
    const idB = useQueuedPromptsStore.getState().queues.sid1[1].id;
    removeQueued(idB);
    expect(texts('sid1')).toEqual(['A']);
    expect(texts('sid2')).toEqual(['C']);

    const before = useQueuedPromptsStore.getState().queues;
    removeQueued('missing-id');
    expect(useQueuedPromptsStore.getState().queues).toBe(before);

    // 末条出队后该 key 整体消失（表内不留空数组）
    removeQueued(useQueuedPromptsStore.getState().queues.sid1[0].id);
    removeQueued(useQueuedPromptsStore.getState().queues.sid2[0].id);
    expect(useQueuedPromptsStore.getState().queues).toEqual({});
  });

  it('migrateQueue：旧 key 全队并到新 key 尾部，旧 key 删除', () => {
    const {enqueue, migrateQueue} = useQueuedPromptsStore.getState();
    enqueue('old', '旧1');
    enqueue('old', '旧2');
    enqueue('new', '新1');
    migrateQueue('old', 'new');
    expect(texts('new')).toEqual(['新1', '旧1', '旧2']);
    expect(useQueuedPromptsStore.getState().queues).not.toHaveProperty('old');
  });

  it('migrateQueue：旧 key 无队列 / 同 key 时不动', () => {
    const {enqueue, migrateQueue} = useQueuedPromptsStore.getState();
    enqueue('a', '保留');
    migrateQueue('missing', 'b');
    expect(texts('a')).toEqual(['保留']);
    expect(useQueuedPromptsStore.getState().queues).not.toHaveProperty('b');
    migrateQueue('a', 'a');
    expect(texts('a')).toEqual(['保留']);
  });

  it('pruneQueues：按 profile + 候选 id 批量清理（删除会话场景）', () => {
    const {enqueue, pruneQueues} = useQueuedPromptsStore.getState();
    enqueue(queuedKeyFor('main', 'live1', 'stored1'), 'x');
    enqueue(queuedKeyFor('main', 'live1b', 'stored1'), 'y');
    enqueue(queuedKeyFor('main', 'live2', 'stored2'), 'z');
    enqueue(queuedKeyFor('other', 'live1', 'stored1'), '别的 profile 同 id');
    // live + 持久化 id 两个候选都传（页面可能挂过任一形态的 key）
    pruneQueues('main', ['live1', 'stored1']);
    const keys = Object.keys(useQueuedPromptsStore.getState().queues);
    expect(keys).toEqual([queuedKeyFor('main', 'live2', 'stored2'), queuedKeyFor('other', 'live1', 'stored1')]);
  });

  it('queuedKeyFor：key = profile + 持久化 id（缺省退回 live sid）', () => {
    expect(queuedKeyFor('main', 'live0001', 'stored-1')).toBe('main:stored-1');
    expect(queuedKeyFor('main', 'live0001')).toBe('main:live0001');
    expect(queuedKeyFor('main', 'live0001', '')).toBe('main:live0001');
    // profile 未知时也不塌成空串（避免与其他形态撞 key）
    expect(queuedKeyFor('', 'live0001', 'stored-1')).toBe('-:stored-1');
  });

  it('LRU：超过 200 个会话淘汰最旧触碰，重新触碰可保活', () => {
    const {enqueue} = useQueuedPromptsStore.getState();
    for (let i = 0; i < 200; i++) {
      enqueue(`sid${i}`, `t${i}`);
    }
    enqueue('sid0', '重写'); // 触碰最旧 key（同一 key 追加）
    enqueue('new1', 'n1'); // 应淘汰 sid1 而非 sid0
    const {queues} = useQueuedPromptsStore.getState();
    expect(Object.keys(queues)).toHaveLength(200);
    expect(queues.sid0.map(it => it.text)).toEqual(['t0', '重写']);
    expect(queues).not.toHaveProperty('sid1');
    expect(queues).toHaveProperty('new1');
  });
});

describe('queuedPrompts store 持久化', () => {
  it('防抖落盘：enqueue 后不立即写，300ms 后写整表', async () => {
    jest.useFakeTimers();
    try {
      useQueuedPromptsStore.getState().enqueue('sid1', '排队中');
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      jest.advanceTimersByTime(300);
      const raw = useQueuedPromptsStore.getState().queues.sid1;
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        STORAGE_KEY,
        JSON.stringify({sid1: raw}),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('loadPersisted：启动恢复（形状不符/空文本/超限条目被过滤）', async () => {
    await AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sid1: [
          {id: 'q1', text: '回来', createdAt: 1},
          {id: 'q2', text: '   '},
          {id: 'q3', text: 42},
          'oops',
        ],
        sid2: 'not-an-array',
        sid3: [],
      }),
    );
    await useQueuedPromptsStore.getState().loadPersisted();
    const {queues} = useQueuedPromptsStore.getState();
    expect(queues.sid1.map(it => it.text)).toEqual(['回来']);
    expect(queues.sid1[0].id).toBe('q1');
    expect(queues).not.toHaveProperty('sid2');
    expect(queues).not.toHaveProperty('sid3');
  });

  it('loadPersisted：缺 id 的条目补一个可用的 id（旧版本数据宽容）', async () => {
    await AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({sid1: [{text: '无 id 条目'}]}),
    );
    await useQueuedPromptsStore.getState().loadPersisted();
    const list = useQueuedPromptsStore.getState().queues.sid1;
    expect(list).toHaveLength(1);
    expect(typeof list[0].id).toBe('string');
    expect(list[0].id.length).toBeGreaterThan(0);
  });

  it('loadPersisted：损坏 JSON 视为空，不抛错', async () => {
    await AsyncStorage.setItem(STORAGE_KEY, '{oops');
    await expect(
      useQueuedPromptsStore.getState().loadPersisted(),
    ).resolves.toBeUndefined();
    expect(useQueuedPromptsStore.getState().queues).toEqual({});
  });

  it('迁移/清理/出队同样落盘', async () => {
    const {enqueue, migrateQueue, pruneQueues, removeQueued} =
      useQueuedPromptsStore.getState();
    enqueue('a', 'x');
    migrateQueue('a', 'b');
    _flushQueuedPromptsForTests();
    expect(await persistedRaw()).toBe(
      JSON.stringify({b: useQueuedPromptsStore.getState().queues.b}),
    );

    const id = useQueuedPromptsStore.getState().queues.b[0].id;
    removeQueued(id);
    _flushQueuedPromptsForTests();
    expect(await persistedRaw()).toBe(JSON.stringify({}));

    enqueue('main:c', 'y');
    pruneQueues('main', ['c', 'missing']);
    _flushQueuedPromptsForTests();
    expect(await persistedRaw()).toBe(JSON.stringify({}));
  });
});
