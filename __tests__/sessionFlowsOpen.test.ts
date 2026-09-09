/**
 * 会话打开/新建对断线重连窗口的容忍：点击瞬间可能正处 reconnecting
 * （回前台探活判死 / WS 被后台掐断），此前裸调 getRpc() 同步抛
 * "rpc not connected"、再点才好；现 flow 入口先 waitReady 等连接
 * 就绪（重连中还会主动跳过退避加速重连）。
 */

import {
  _resetChatAggregators,
  useChatStore,
} from '../src/store/chat';
import {
  _resetConnectionTimers,
  useConnectionStore,
} from '../src/store/connection';
import {
  createSessionFlow,
  openSessionFlow,
} from '../src/panels/sessionFlows';
import {useSessionsStore} from '../src/store/sessions';
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
    title: '会话',
    preview: '',
    started_at: 0,
    message_count: 0,
    source: 'tui',
  };
}

function mockResume() {
  mockCall.mockImplementation(async (method: string) => {
    if (method === 'session.resume') {
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
}

describe('flow 入口等待连接就绪（rpc not connected 修复）', () => {
  beforeEach(() => {
    _resetChatAggregators();
    useChatStore.setState({bySession: {}});
    useSessionsStore.setState({byProfile: {}, stale: false, nsMap: null});
    useConnectionStore.setState({state: 'ready'});
    mockCall.mockReset();
  });

  afterEach(() => {
    _resetConnectionTimers();
  });

  it('ready 态：正常打开走通（回归保护）', async () => {
    mockResume();
    const opened = await openSessionFlow('main', row('stored1'));
    expect(opened).toEqual({sessionId: 'sid1', title: '会话'});
    expect(mockCall).toHaveBeenCalledWith(
      'session.resume',
      expect.objectContaining({profile: 'main'}),
    );
  });

  it('disconnected 态：报「未连接」且不发 RPC（不再裸调 getRpc）', async () => {
    useConnectionStore.setState({state: 'disconnected'});
    await expect(openSessionFlow('main', row('stored1'))).rejects.toThrow(
      '未连接',
    );
    await expect(createSessionFlow('main')).rejects.toThrow('未连接');
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('reconnecting 窗口点击：等重连恢复后成功打开，不报错', async () => {
    jest.useFakeTimers();
    useConnectionStore.setState({state: 'reconnecting'});
    mockResume();
    const p = openSessionFlow('main', row('stored1'));
    // waitReady 已进 200ms 轮询：推进一轮仍未就绪，模拟 1s 内重连成功，
    // 再推进一轮轮询发现 ready → 放行 resume
    await jest.advanceTimersByTimeAsync(200);
    useConnectionStore.setState({state: 'ready'});
    await jest.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toEqual({sessionId: 'sid1', title: '会话'});
    expect(mockCall).toHaveBeenCalledWith('session.resume', expect.anything());
  });
});
