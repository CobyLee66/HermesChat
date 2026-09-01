import {
  _resetConnectionTimers,
  backoffDelay,
  useConnectionStore,
  DEFAULT_CONFIG,
  type Connector,
} from '../src/store/connection';

function makeConnector(opts: {
  /** 首次 connect 成功后的连续失败次数（模拟重连期失败） */
  failTimes?: number;
  /** 首次 connect 也失败（测试连接失败路径） */
  failFirst?: boolean;
}): Connector & {connectCalls: number; resumeCalls: number} {
  let failuresLeft = opts.failTimes ?? 0;
  let failFirst = opts.failFirst ?? false;
  const c = {
    connectCalls: 0,
    resumeCalls: 0,
    async connect() {
      c.connectCalls += 1;
      if (failFirst) {
        failFirst = false;
        throw new Error('connect failed');
      }
      if (c.connectCalls > 1 && failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('connect failed');
      }
      return {
        rpc: {onAny: jest.fn(), isOpen: true} as never,
        wsUrl: 'ws://127.0.0.1:9119/api/ws?token=t',
        httpUrl: 'http://127.0.0.1:9119',
        token: 't',
      };
    },
    async disconnect() {},
    onDrop() {},
    async resumeActiveSessions() {
      c.resumeCalls += 1;
    },
  };
  return c;
}

describe('backoffDelay 指数退避', () => {
  it('1s → 2s → 4s … 封顶 30s', () => {
    expect(backoffDelay(0)).toBe(1000);
    expect(backoffDelay(1)).toBe(2000);
    expect(backoffDelay(2)).toBe(4000);
    expect(backoffDelay(3)).toBe(8000);
    expect(backoffDelay(4)).toBe(16000);
    expect(backoffDelay(5)).toBe(30000);
    expect(backoffDelay(10)).toBe(30000);
  });
});

describe('connection 状态机', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    _resetConnectionTimers();
    useConnectionStore.setState({
      state: 'disconnected',
      error: null,
      wsUrl: '',
      httpUrl: '',
      token: '',
      config: DEFAULT_CONFIG,
      reconnectAttempt: 0,
      connector: null,
    });
  });

  afterEach(() => {
    _resetConnectionTimers();
    jest.useRealTimers();
  });

  it('connect 成功：disconnected → connecting → bootstrapping → ready', async () => {
    const connector = makeConnector({});
    const seen: string[] = [useConnectionStore.getState().state];
    useConnectionStore.subscribe(s => {
      const last = seen[seen.length - 1];
      if (s.state !== last) {
        seen.push(s.state);
      }
    });
    useConnectionStore.getState().setConnector(connector);
    const ok = await useConnectionStore.getState().connect();
    expect(ok).toBe(true);
    expect(useConnectionStore.getState().state).toBe('ready');
    expect(seen).toEqual(['disconnected', 'connecting', 'bootstrapping', 'ready']);
    expect(useConnectionStore.getState().token).toBe('t');
  });

  it('connect 失败回到 disconnected 并记录 error', async () => {
    const connector = makeConnector({failFirst: true});
    useConnectionStore.getState().setConnector(connector);
    const ok = await useConnectionStore.getState().connect();
    expect(ok).toBe(false);
    expect(useConnectionStore.getState().state).toBe('disconnected');
    expect(useConnectionStore.getState().error).toContain('connect failed');
  });

  it('断线 → reconnecting，按退避重试，成功后 ready 且 resume 活跃会话', async () => {
    const connector = makeConnector({failTimes: 2});
    const store = useConnectionStore.getState();
    store.setConnector(connector);
    await useConnectionStore.getState().connect();
    expect(useConnectionStore.getState().state).toBe('ready');
    expect(connector.connectCalls).toBe(1);

    useConnectionStore.getState().handleDrop('ws closed code=1006');
    expect(useConnectionStore.getState().state).toBe('reconnecting');

    // 第 1 次重试：1s 后，失败
    await jest.advanceTimersByTimeAsync(1000);
    expect(connector.connectCalls).toBe(2);
    expect(useConnectionStore.getState().state).toBe('reconnecting');
    expect(useConnectionStore.getState().reconnectAttempt).toBe(1);

    // 第 2 次重试：再 2s 后，仍失败
    await jest.advanceTimersByTimeAsync(2000);
    expect(connector.connectCalls).toBe(3);
    expect(useConnectionStore.getState().reconnectAttempt).toBe(2);

    // 第 3 次重试：再 4s 后，成功 → ready + resume
    await jest.advanceTimersByTimeAsync(4000);
    expect(useConnectionStore.getState().state).toBe('ready');
    expect(connector.resumeCalls).toBe(1);
    expect(useConnectionStore.getState().reconnectAttempt).toBe(0);
  });

  it('retryNow 立即重置退避并重试', async () => {
    const connector = makeConnector({});
    useConnectionStore.getState().setConnector(connector);
    await useConnectionStore.getState().connect();
    useConnectionStore.getState().handleDrop('drop');
    expect(useConnectionStore.getState().state).toBe('reconnecting');

    useConnectionStore.getState().retryNow();
    // retryNow 重置 attempt → 1s 后即重试
    await jest.advanceTimersByTimeAsync(1000);
    expect(connector.connectCalls).toBe(2);
    expect(useConnectionStore.getState().state).toBe('ready');
  });

  it('disconnect 停止重连', async () => {
    const connector = makeConnector({failTimes: 99});
    useConnectionStore.getState().setConnector(connector);
    await useConnectionStore.getState().connect();
    useConnectionStore.getState().handleDrop('drop');
    await useConnectionStore.getState().disconnect();
    expect(useConnectionStore.getState().state).toBe('disconnected');
    await jest.advanceTimersByTimeAsync(60000);
    expect(connector.connectCalls).toBe(1); // 未再重试
  });

  it('重复 handleDrop 不叠加定时器', async () => {
    const connector = makeConnector({});
    useConnectionStore.getState().setConnector(connector);
    await useConnectionStore.getState().connect();
    useConnectionStore.getState().handleDrop('a');
    useConnectionStore.getState().handleDrop('b');
    await jest.advanceTimersByTimeAsync(1000);
    expect(connector.connectCalls).toBe(2); // 只重试一次
    expect(useConnectionStore.getState().state).toBe('ready');
  });
});
