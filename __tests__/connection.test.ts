import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  _resetConnectionTimers,
  backoffDelay,
  EMPTY_PROFILE,
  STORAGE_KEY,
  useConnectionStore,
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

/** 造一条测试配置并入库。 */
function seedProfile(name = '测试机') {
  return useConnectionStore.getState().addProfile({
    ...EMPTY_PROFILE,
    name,
    host: '192.168.1.10',
    username: 'user',
  });
}

function resetStore() {
  useConnectionStore.setState({
    state: 'disconnected',
    error: null,
    wsUrl: '',
    httpUrl: '',
    token: '',
    profiles: [],
    currentProfileId: null,
    autoProfileId: null,
    reconnectAttempt: 0,
    connector: null,
  });
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

describe('profiles 管理', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    _resetConnectionTimers();
    resetStore();
    await AsyncStorage.clear();
  });

  afterEach(() => {
    _resetConnectionTimers();
    jest.useRealTimers();
  });

  it('addProfile 生成 id，全字段持久化（含 password/privateKey）', async () => {
    const p = useConnectionStore.getState().addProfile({
      name: '办公电脑',
      host: '10.0.0.2',
      port: '2222',
      username: 'dev',
      password: 'pw',
      privateKey: 'PEM',
      passphrase: 'pp',
      keyFileName: 'id_rsa',
    });
    expect(p.id).toBeTruthy();
    expect(useConnectionStore.getState().profiles).toHaveLength(1);

    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    const saved = JSON.parse(raw as string);
    expect(saved.profiles).toHaveLength(1);
    expect(saved.profiles[0]).toMatchObject({
      id: p.id,
      name: '办公电脑',
      host: '10.0.0.2',
      port: '2222',
      username: 'dev',
      password: 'pw',
      privateKey: 'PEM',
      passphrase: 'pp',
      keyFileName: 'id_rsa',
    });
  });

  it('updateProfile 修改字段且不改 id，并持久化', async () => {
    const p = seedProfile();
    useConnectionStore
      .getState()
      .updateProfile(p.id, {name: '新名字', port: '2200'});
    const after = useConnectionStore.getState().profiles[0];
    expect(after.id).toBe(p.id);
    expect(after.name).toBe('新名字');
    expect(after.port).toBe('2200');
    expect(after.host).toBe('192.168.1.10');

    const saved = JSON.parse(
      (await AsyncStorage.getItem(STORAGE_KEY)) as string,
    );
    expect(saved.profiles[0].name).toBe('新名字');
  });

  it('removeProfile 删除并清理 current/auto 引用', () => {
    const p = seedProfile();
    useConnectionStore.getState().setAutoProfile(p.id);
    useConnectionStore.setState({currentProfileId: p.id});
    useConnectionStore.getState().removeProfile(p.id);
    const s = useConnectionStore.getState();
    expect(s.profiles).toHaveLength(0);
    expect(s.autoProfileId).toBeNull();
    expect(s.currentProfileId).toBeNull();
  });

  it('setAutoProfile 全局唯一：设新的顶替旧的，可传 null 取消', () => {
    const a = seedProfile('A');
    const b = seedProfile('B');
    useConnectionStore.getState().setAutoProfile(a.id);
    expect(useConnectionStore.getState().autoProfileId).toBe(a.id);
    useConnectionStore.getState().setAutoProfile(b.id);
    expect(useConnectionStore.getState().autoProfileId).toBe(b.id);
    useConnectionStore.getState().setAutoProfile(null);
    expect(useConnectionStore.getState().autoProfileId).toBeNull();
  });

  it('loadPersisted 回读 profiles / currentProfileId / autoProfileId', async () => {
    const a = seedProfile('A');
    const b = seedProfile('B');
    useConnectionStore.getState().setAutoProfile(b.id);
    // connect(profileId) 是唯一写 currentProfileId 并落盘的 action
    useConnectionStore.getState().setConnector(makeConnector({}));
    await useConnectionStore.getState().connect(a.id);

    // 模拟冷启动：清空内存态后从 AsyncStorage 恢复
    useConnectionStore.setState({
      state: 'disconnected',
      profiles: [],
      currentProfileId: null,
      autoProfileId: null,
    });
    await useConnectionStore.getState().loadPersisted();
    const s = useConnectionStore.getState();
    expect(s.profiles.map(p => p.id)).toEqual([a.id, b.id]);
    expect(s.profiles[0].name).toBe('A');
    expect(s.currentProfileId).toBe(a.id);
    expect(s.autoProfileId).toBe(b.id);
  });
});

describe('connection 状态机', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    _resetConnectionTimers();
    resetStore();
    await AsyncStorage.clear();
  });

  afterEach(() => {
    _resetConnectionTimers();
    jest.useRealTimers();
  });

  it('connect 成功：disconnected → connecting → bootstrapping → ready，并记 currentProfileId', async () => {
    const connector = makeConnector({});
    const seen: string[] = [useConnectionStore.getState().state];
    useConnectionStore.subscribe(s => {
      const last = seen[seen.length - 1];
      if (s.state !== last) {
        seen.push(s.state);
      }
    });
    useConnectionStore.getState().setConnector(connector);
    const p = seedProfile();
    const ok = await useConnectionStore.getState().connect(p.id);
    expect(ok).toBe(true);
    expect(useConnectionStore.getState().state).toBe('ready');
    expect(seen).toEqual(['disconnected', 'connecting', 'bootstrapping', 'ready']);
    expect(useConnectionStore.getState().token).toBe('t');
    expect(useConnectionStore.getState().currentProfileId).toBe(p.id);
  });

  it('无配置时 connect 报错回到 disconnected', async () => {
    const connector = makeConnector({});
    useConnectionStore.getState().setConnector(connector);
    const ok = await useConnectionStore.getState().connect();
    expect(ok).toBe(false);
    expect(useConnectionStore.getState().state).toBe('disconnected');
    expect(useConnectionStore.getState().error).toContain('未找到当前连接配置');
  });

  it('connect 失败回到 disconnected 并记录 error', async () => {
    const connector = makeConnector({failFirst: true});
    useConnectionStore.getState().setConnector(connector);
    const p = seedProfile();
    const ok = await useConnectionStore.getState().connect(p.id);
    expect(ok).toBe(false);
    expect(useConnectionStore.getState().state).toBe('disconnected');
    expect(useConnectionStore.getState().error).toContain('connect failed');
  });

  it('断线 → reconnecting，按退避重试，成功后 ready 且 resume 活跃会话', async () => {
    const connector = makeConnector({failTimes: 2});
    const store = useConnectionStore.getState();
    store.setConnector(connector);
    const p = seedProfile();
    await useConnectionStore.getState().connect(p.id);
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
    const p = seedProfile();
    await useConnectionStore.getState().connect(p.id);
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
    const p = seedProfile();
    await useConnectionStore.getState().connect(p.id);
    useConnectionStore.getState().handleDrop('drop');
    await useConnectionStore.getState().disconnect();
    expect(useConnectionStore.getState().state).toBe('disconnected');
    await jest.advanceTimersByTimeAsync(60000);
    expect(connector.connectCalls).toBe(1); // 未再重试
  });

  it('重复 handleDrop 不叠加定时器', async () => {
    const connector = makeConnector({});
    useConnectionStore.getState().setConnector(connector);
    const p = seedProfile();
    await useConnectionStore.getState().connect(p.id);
    useConnectionStore.getState().handleDrop('a');
    useConnectionStore.getState().handleDrop('b');
    await jest.advanceTimersByTimeAsync(1000);
    expect(connector.connectCalls).toBe(2); // 只重试一次
    expect(useConnectionStore.getState().state).toBe('ready');
  });

  describe('健康探活看门狗（D028 僵尸连接兜底）', () => {
    const originalFetch = (globalThis as {fetch?: unknown}).fetch;
    let fetchMock: jest.Mock;

    beforeEach(() => {
      fetchMock = jest.fn();
      (globalThis as {fetch?: unknown}).fetch = fetchMock;
    });

    afterEach(() => {
      (globalThis as {fetch?: unknown}).fetch = originalFetch;
    });

    async function connectReady() {
      const connector = makeConnector({});
      useConnectionStore.getState().setConnector(connector);
      const p = seedProfile();
      await useConnectionStore.getState().connect(p.id);
      expect(useConnectionStore.getState().state).toBe('ready');
      return connector;
    }

    it('周期探活：单次失败不判定，连续 2 次失败触发重连', async () => {
      const connector = await connectReady();

      // 第 1 次探活失败：不误杀
      fetchMock.mockResolvedValueOnce({ok: false});
      await jest.advanceTimersByTimeAsync(30_000);
      expect(useConnectionStore.getState().state).toBe('ready');
      expect(connector.connectCalls).toBe(1);

      // 第 2 次失败：判定断线 → reconnecting（30s 超时 + 1s 后重试成功）
      fetchMock.mockResolvedValueOnce({ok: false});
      await jest.advanceTimersByTimeAsync(30_000);
      expect(useConnectionStore.getState().state).toBe('reconnecting');
      await jest.advanceTimersByTimeAsync(1000);
      expect(useConnectionStore.getState().state).toBe('ready');
      expect(connector.connectCalls).toBe(2);

      // 恢复后探活成功不触发
      fetchMock.mockResolvedValueOnce({ok: true});
      await jest.advanceTimersByTimeAsync(30_000);
      expect(useConnectionStore.getState().state).toBe('ready');
      expect(connector.connectCalls).toBe(2);
    });

    it('handleForeground：ready 时探活失败立即触发重连；reconnecting 时等价 retryNow', async () => {
      const connector = await connectReady();

      fetchMock.mockResolvedValueOnce({ok: false});
      useConnectionStore.getState().handleForeground();
      await jest.advanceTimersByTimeAsync(0);
      expect(useConnectionStore.getState().state).toBe('reconnecting');
      await jest.advanceTimersByTimeAsync(1000);
      expect(useConnectionStore.getState().state).toBe('ready');

      // reconnecting 态回前台 = retryNow（立即重试，不探活）
      useConnectionStore.getState().handleDrop('drop');
      useConnectionStore.getState().handleForeground();
      await jest.advanceTimersByTimeAsync(1000);
      expect(useConnectionStore.getState().state).toBe('ready');
      expect(fetchMock).toHaveBeenCalledTimes(1); // 第二次前台未发探活
    });
  });
});
