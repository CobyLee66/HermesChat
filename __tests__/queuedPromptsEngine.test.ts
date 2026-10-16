/**
 * queuedPromptsEngine：排队消息的排水行为。
 *
 * 被测语义（D064）：
 * - 提交始终带 `prompt.submit {queued: true}`（服务端「客户端队列排水」契约，
 *   忙态只入队不打断）；
 * - 只在「连接 ready + 会话已挂载 + 观测空闲」时一次送队首一条，成功后逐条推进；
 * - 触发面 = 外部事件（连接就绪 / 空闲翻转 / attach / 条目变化 / 用户中断），
 *   失败不自激重试（失败会写错误条 → 若按任意 store 变更重试就会立刻打转）。
 */
import {_resetChatAggregators, useChatStore} from '../src/store/chat';
import {useConnectionStore} from '../src/store/connection';
import {_resetDraftsForTests} from '../src/store/drafts';
import {
  _resetQueuedPromptsForTests,
  queuedKeyFor,
  useQueuedPromptsStore,
} from '../src/store/queuedPrompts';
import {
  _resetQueuedPromptsEngineForTests,
  forceFlushQueued,
  initQueuedPromptsEngine,
} from '../src/store/queuedPromptsEngine';

const mockCall = jest.fn<Promise<unknown>, [string, Record<string, unknown>?]>();

jest.mock('../src/rpc/runtime', () => ({
  getRpc: () => ({call: mockCall}),
  setRpc: jest.fn(),
  hasRpc: () => true,
}));

/** 冲刷微任务/宏任务（引擎经微任务延迟送出，store 更新同步传播） */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>(r => setImmediate(r));
  }
}

/** 排队 key = 会话跨重启身份（profile + 持久化会话 id） */
function keyOf(liveSid = 's1', storedId = 'stored-s1'): string {
  return queuedKeyFor('main', liveSid, storedId);
}

function queuedTexts(key: string): string[] {
  return (useQueuedPromptsStore.getState().queues[key] ?? []).map(it => it.text);
}

function setBusy(sid: string, busy: boolean) {
  useChatStore.setState(s => ({
    bySession: {...s.bySession, [sid]: {...s.bySession[sid], busy}},
  }));
}

/** 会话进入「已知且空闲」的常规准备：连接 ready + attach 一条空历史 */
function readyIdleSession(sid = 's1', extra: Record<string, unknown> = {}) {
  useConnectionStore.setState({state: 'ready'});
  useChatStore.getState().attach(sid, {
    messages: [],
    profile: 'main',
    storedSessionId: `stored-${sid}`,
    ...extra,
  });
}

beforeEach(() => {
  _resetChatAggregators();
  _resetDraftsForTests();
  _resetQueuedPromptsForTests();
  _resetQueuedPromptsEngineForTests();
  mockCall.mockReset().mockResolvedValue({status: 'streaming'});
  useChatStore.setState({bySession: {}});
  useConnectionStore.setState({state: 'disconnected'});
});

afterEach(() => {
  _resetQueuedPromptsEngineForTests();
});

describe('排水：正常路径', () => {
  it('连接 ready + 会话空闲：送队首一条，带 queued:true，并出队 + 回显用户气泡', async () => {
    readyIdleSession();
    useQueuedPromptsStore.getState().enqueue(keyOf(), '排队一');
    initQueuedPromptsEngine();
    await flush();

    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(mockCall).toHaveBeenCalledWith('prompt.submit', {
      session_id: 's1',
      text: '排队一',
      queued: true,
    });
    // 出队（表内不留空数组）
    expect(useQueuedPromptsStore.getState().queues).toEqual({});
    // 本地回显用户气泡，且 busy 置位（本条已成为当前轮）
    const st = useChatStore.getState().bySession.s1;
    expect(st.busy).toBe(true);
    expect(
      st.items.some(it => it.kind === 'user' && it.text === '排队一'),
    ).toBe(true);
  });

  it('busy 期间不动手；busy 翻转 false（turn 结束）后自动发送', async () => {
    readyIdleSession('s1', {running: true});
    useQueuedPromptsStore.getState().enqueue(keyOf(), '等这一轮结束');
    initQueuedPromptsEngine();
    await flush();
    expect(mockCall).not.toHaveBeenCalled();
    expect(queuedTexts(keyOf())).toEqual(['等这一轮结束']);

    setBusy('s1', false);
    await flush();
    expect(mockCall).toHaveBeenCalledWith(
      'prompt.submit',
      expect.objectContaining({text: '等这一轮结束', queued: true}),
    );
    expect(useQueuedPromptsStore.getState().queues).toEqual({});
  });

  it('断线不发；连接变 ready 后补发（跨断线不丢）', async () => {
    useChatStore.getState().attach('s1', {
      messages: [],
      profile: 'main',
      storedSessionId: 'stored-s1',
    });
    useQueuedPromptsStore.getState().enqueue(keyOf(), '离线时排的');
    initQueuedPromptsEngine();
    await flush();
    expect(mockCall).not.toHaveBeenCalled();
    expect(queuedTexts(keyOf())).toEqual(['离线时排的']);

    useConnectionStore.setState({state: 'ready'});
    await flush();
    expect(mockCall).toHaveBeenCalledWith(
      'prompt.submit',
      expect.objectContaining({text: '离线时排的', queued: true}),
    );
    expect(useQueuedPromptsStore.getState().queues).toEqual({});
  });

  it('进入会话（attach）时补发此前排队的内容', async () => {
    useConnectionStore.setState({state: 'ready'});
    useQueuedPromptsStore.getState().enqueue(keyOf(), '重进补发');
    initQueuedPromptsEngine();
    await flush();
    // 会话还没挂载（App 重启后没进过这个会话）：只排队不发送
    expect(mockCall).not.toHaveBeenCalled();

    useChatStore.getState().attach('s1', {
      messages: [],
      profile: 'main',
      storedSessionId: 'stored-s1',
    });
    await flush();
    expect(mockCall).toHaveBeenCalledWith(
      'prompt.submit',
      expect.objectContaining({text: '重进补发', queued: true}),
    );
  });

  it('逐条推进：一次只送队首，前一条的 turn 结束后才发下一条', async () => {
    readyIdleSession();
    const {enqueue} = useQueuedPromptsStore.getState();
    enqueue(keyOf(), 'A');
    enqueue(keyOf(), 'B');
    initQueuedPromptsEngine();
    await flush();

    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(mockCall).toHaveBeenNthCalledWith(
      1,
      'prompt.submit',
      expect.objectContaining({text: 'A', queued: true}),
    );
    expect(queuedTexts(keyOf())).toEqual(['B']);

    // A 的 turn 结束（busy 翻转）→ 才发 B
    setBusy('s1', false);
    await flush();
    expect(mockCall).toHaveBeenCalledTimes(2);
    expect(mockCall).toHaveBeenNthCalledWith(
      2,
      'prompt.submit',
      expect.objectContaining({text: 'B', queued: true}),
    );
    expect(useQueuedPromptsStore.getState().queues).toEqual({});
  });

  it('forceFlushQueued（用户点中断）：跳过 busy 门补发队首', async () => {
    readyIdleSession('s1', {running: true});
    useQueuedPromptsStore.getState().enqueue(keyOf(), '中断后补发');
    initQueuedPromptsEngine();
    await flush();
    expect(mockCall).not.toHaveBeenCalled();

    forceFlushQueued('s1');
    await flush();
    expect(mockCall).toHaveBeenCalledWith(
      'prompt.submit',
      expect.objectContaining({text: '中断后补发', queued: true}),
    );
    expect(useQueuedPromptsStore.getState().queues).toEqual({});
  });

  it('key 用持久化身份：App 退出重进换了 live sid 也能认领并发送', async () => {
    useConnectionStore.setState({state: 'ready'});
    // 排队发生在旧的 live sid 下（key 只记 profile + 持久化 id）
    useQueuedPromptsStore.getState().enqueue(keyOf('liveOLD'), '跨 live sid');
    initQueuedPromptsEngine();
    await flush();
    expect(mockCall).not.toHaveBeenCalled();

    // 重进会话：服务端给了新的 live sid，持久化 id 不变
    useChatStore.getState().attach('liveNEW', {
      messages: [],
      profile: 'main',
      storedSessionId: 'stored-s1',
    });
    await flush();
    expect(mockCall).toHaveBeenCalledWith('prompt.submit', {
      session_id: 'liveNEW',
      text: '跨 live sid',
      queued: true,
    });
    expect(useQueuedPromptsStore.getState().queues).toEqual({});
  });

  it('同一持久化身份有迁移 shell 时：发往非 shell 的会话', async () => {
    useConnectionStore.setState({state: 'ready'});
    useChatStore.getState().attach('s1', {
      messages: [],
      profile: 'main',
      storedSessionId: 'stored-s1',
    });
    useChatStore.getState().attach('s2', {
      messages: [],
      profile: 'main',
      storedSessionId: 'stored-s1',
    });
    // 旧 key 变迁移 shell（reattachAfterResume 的形态）
    useChatStore.setState(s => ({
      bySession: {...s.bySession, s1: {...s.bySession.s1, migratedTo: 's2'}},
    }));
    useQueuedPromptsStore.getState().enqueue(keyOf('s1'), '跟着迁移');
    initQueuedPromptsEngine();
    await flush();
    expect(mockCall).toHaveBeenCalledWith(
      'prompt.submit',
      expect.objectContaining({session_id: 's2', text: '跟着迁移'}),
    );
  });
});

describe('排水：跳过与失败', () => {
  it('foreign 只读视图不排水（条目保留）', async () => {
    useConnectionStore.setState({state: 'ready'});
    useChatStore.getState().attach('s1', {
      messages: [],
      profile: 'main',
      storedSessionId: 'stored-s1',
      foreign: {originId: 'origin-1', hostProfile: 'other'},
    });
    useQueuedPromptsStore.getState().enqueue(keyOf(), '不该发');
    initQueuedPromptsEngine();
    await flush();
    expect(mockCall).not.toHaveBeenCalled();
    expect(queuedTexts(keyOf())).toEqual(['不该发']);
  });

  it('已迁移 shell（migratedTo）不排水', async () => {
    readyIdleSession();
    useChatStore.setState(s => ({
      bySession: {
        ...s.bySession,
        s1: {...s.bySession.s1, migratedTo: 's2'},
      },
    }));
    useQueuedPromptsStore.getState().enqueue(keyOf(), '不该发');
    initQueuedPromptsEngine();
    await flush();
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('自愈失败（未尝试发送）：条目保留、只试一次、不自激循环', async () => {
    readyIdleSession();
    // 模拟 live sid 已失效：发送前先走自愈 resume（此处让它失败）
    useChatStore.getState().markStaleLive('s1');
    mockCall.mockImplementation((method: string) =>
      method === 'session.resume'
        ? Promise.reject(new Error('session gone'))
        : Promise.resolve({status: 'streaming'}),
    );
    useQueuedPromptsStore.getState().enqueue(keyOf(), '失败保留');
    initQueuedPromptsEngine();
    await flush(10);

    // resume 试过一次；prompt.submit 从未发出（未尝试 → 保留队首可重试）
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(mockCall).toHaveBeenCalledWith(
      'session.resume',
      expect.objectContaining({session_id: 'stored-s1'}),
    );
    expect(queuedTexts(keyOf())).toEqual(['失败保留']);
    // 失败写下的错误条（一次 store set）不会再次触发排水
    await flush(10);
    expect(mockCall).toHaveBeenCalledTimes(1);
  });

  it('失败后按最小重试间隔节流，超过间隔的下一个外部事件才重试', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(2_000_000);
      readyIdleSession();
      useChatStore.getState().markStaleLive('s1');
      mockCall.mockImplementation((method: string) =>
        method === 'session.resume'
          ? Promise.reject(new Error('session gone'))
          : Promise.resolve({status: 'streaming'}),
      );
      useQueuedPromptsStore.getState().enqueue(keyOf(), '节流');
      initQueuedPromptsEngine();
      await flush(10);
      expect(mockCall).toHaveBeenCalledTimes(1);

      // 500ms 后连接重新就绪：节流拦住
      nowSpy.mockReturnValue(2_000_500);
      useConnectionStore.setState({state: 'reconnecting'});
      useConnectionStore.setState({state: 'ready'});
      await flush(10);
      expect(mockCall).toHaveBeenCalledTimes(1);

      // 1.2s 后同样的外部事件：放行重试
      nowSpy.mockReturnValue(2_001_200);
      useConnectionStore.setState({state: 'reconnecting'});
      useConnectionStore.setState({state: 'ready'});
      await flush(10);
      expect(mockCall).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
