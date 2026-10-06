/**
 * 会话列表「假空」回归测试：
 * - refresh 在断线重连窗口内等待连接就绪（waitReady），不秒败；
 * - 等待失败/未连接时 error 落 store，byProfile 不写入空数组
 *   （UI 据此显示错误态而非「没有任何会话」）；
 * - openSessionFlow 对连接类错误（1006 connection lost）重试一次自愈。
 * rpc 全部 mock，不打真实服务。
 */

import {
  _resetChatAggregators,
  useChatStore,
} from '../src/store/chat';
import {
  _resetConnectionTimers,
  useConnectionStore,
  type ConnectionProfile,
  type Connector,
} from '../src/store/connection';
import {openSessionFlow} from '../src/panels/sessionFlows';
import {useProfilesStore} from '../src/store/profiles';
import {useSessionsStore} from '../src/store/sessions';
import {setExecRemote} from '../src/ssh/execRemote';
import type {RpcClient} from '../src/rpc/client';
import type {SessionListRow} from '../src/rpc/types';

const mockCall = jest.fn<Promise<unknown>, [string, Record<string, unknown>?]>();

jest.mock('../src/rpc/runtime', () => ({
  getRpc: () => ({call: mockCall}),
  setRpc: jest.fn(),
  hasRpc: () => true,
}));

function row(id: string): SessionListRow {
  return {
    id,
    title: `t-${id}`,
    preview: '',
    started_at: 100,
    message_count: 1,
    source: 'tui',
  };
}

/** 可立即连通的 mock connector：reconnecting → connectInternal → ready。 */
function makeConnector(): Connector {
  const rpc = {call: mockCall, onAny: jest.fn(), isOpen: true};
  return {
    connect: jest.fn(async () => ({
      rpc: rpc as unknown as RpcClient,
      wsUrl: 'ws://example.com',
      httpUrl: 'http://example.com',
    })),
    disconnect: jest.fn(async () => {}),
    onDrop: jest.fn(),
    resumeActiveSessions: jest.fn(async () => {}),
  };
}

function seedConnectionProfile() {
  const profile = {
    id: 'p1',
    name: 'test',
    type: 'direct',
    host: 'example.com',
    port: '9119',
    username: '',
    password: '',
    privateKey: '',
    passphrase: '',
    keyFileName: '',
    token: '',
  } as ConnectionProfile;
  useConnectionStore.setState({profiles: [profile], currentProfileId: 'p1'});
}

function resetStores() {
  mockCall.mockReset();
  _resetChatAggregators();
  useChatStore.setState({bySession: {}});
  useSessionsStore.setState({
    byProfile: {},
    loading: false,
    error: null,
    stale: false,
    nsMap: null,
  });
  useProfilesStore.setState({list: [], avatars: {}, loading: false, error: null});
  setExecRemote(null);
}

describe('sessions.refresh 断线容忍', () => {
  beforeEach(() => {
    resetStores();
    useConnectionStore.getState().setConnector(makeConnector());
    seedConnectionProfile();
  });

  afterEach(() => {
    _resetConnectionTimers();
    useConnectionStore.setState({state: 'disconnected', connector: null});
  });

  it('ready 态：正常拉取填充 byProfile（回归保护）', async () => {
    useConnectionStore.setState({state: 'ready'});
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'session.list') {
        return {sessions: [row('s1')]};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });
    await useSessionsStore.getState().refresh('main', true);
    expect(useSessionsStore.getState().byProfile.main).toHaveLength(1);
    expect(useSessionsStore.getState().error).toBeNull();
  });

  it('reconnecting 态：等待重连接绪后拉取成功，不秒败（假空根因修复）', async () => {
    useConnectionStore.setState({state: 'reconnecting', reconnectAttempt: 0});
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'session.list') {
        return {sessions: [row('s1'), row('s2')]};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });
    // 不 await：refresh 应挂在 waitReady 里等重连（retryNow 1s 后 mock connector 连通）
    const p = useSessionsStore.getState().refresh('main', true);
    // 等待期间绝不能产出空列表结果
    expect(useSessionsStore.getState().byProfile.main).toBeUndefined();
    await p;
    const st = useSessionsStore.getState();
    expect(st.error).toBeNull();
    expect(st.byProfile.main).toHaveLength(2);
    expect(
      mockCall.mock.calls.some(c => c[0] === 'session.list'),
    ).toBe(true);
  }, 15000);

  it('disconnected 态：error 落 store，byProfile 不写入空数组（不显示假空态）', async () => {
    useConnectionStore.setState({state: 'disconnected'});
    await useSessionsStore.getState().refresh('main', true);
    const st = useSessionsStore.getState();
    expect(st.error).toBeTruthy();
    expect(st.byProfile.main).toBeUndefined();
    expect(
      mockCall.mock.calls.some(c => c[0] === 'session.list'),
    ).toBe(false);
  });

  it('loading 并发去重：进行中的 refresh 不被第二次调用打断', async () => {
    useConnectionStore.setState({state: 'ready'});
    let resolveList: (v: unknown) => void = () => {};
    mockCall.mockImplementation(
      async (method: string) => {
        if (method === 'session.list') {
          return new Promise(r => {
            resolveList = r;
          });
        }
        throw new Error(`unexpected rpc: ${method}`);
      },
    );
    const p1 = useSessionsStore.getState().refresh('main', true);
    // 第一次还挂在 RPC 上：第二次（含 force）直接跳过
    const p2 = useSessionsStore.getState().refresh('main', true);
    // 等第一次推进到 RPC 调用点再断言（微任务冲刷）
    await new Promise<void>(r => {
      setImmediate(() => r());
    });
    expect(
      mockCall.mock.calls.filter(c => c[0] === 'session.list'),
    ).toHaveLength(1);
    resolveList({sessions: []});
    await Promise.all([p1, p2]);
  });
});

describe('openSessionFlow 连接类错误重试（1006 自愈）', () => {
  beforeEach(() => {
    resetStores();
    useConnectionStore.setState({state: 'ready'});
  });

  afterEach(() => {
    _resetConnectionTimers();
  });

  it('resume 首次遇 connection lost → 等连接就绪重试一次成功', async () => {
    let resumeAttempts = 0;
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'session.resume') {
        resumeAttempts += 1;
        if (resumeAttempts === 1) {
          throw new Error('connection lost: ws closed code=1006');
        }
        return {
          session_id: 'sid1',
          stored_session_id: 'stored1',
          running: false,
          messages: [],
          info: {model: 'mock-model'},
        };
      }
      throw new Error(`unexpected rpc: ${method}`);
    });
    const opened = await openSessionFlow('main', row('stored1'));
    expect(opened).toEqual({sessionId: 'sid1', title: 't-stored1'});
    expect(resumeAttempts).toBe(2);
  });

  it('非连接类错误不重试：直接抛出且只调一次', async () => {
    let resumeAttempts = 0;
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'session.resume') {
        resumeAttempts += 1;
        throw new Error('server exploded');
      }
      throw new Error(`unexpected rpc: ${method}`);
    });
    await expect(openSessionFlow('main', row('stored1'))).rejects.toThrow(
      'server exploded',
    );
    expect(resumeAttempts).toBe(1);
  });
});
