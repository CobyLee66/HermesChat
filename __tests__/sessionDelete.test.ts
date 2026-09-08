/**
 * 删除会话的宿主库路由（multiplex）：namespaced 行物理在宿主 profile 的
 * state.db，session.delete 必须传宿主 profile——按显示 profile 传参会在该
 * profile 自己的库里找行 → 4007 "session not found"（删除报错但列表仍可见
 * 的根因）。id 归一化（live sid → 持久化 id）见 sessionTitle.test.ts。
 */

import {_resetChatAggregators, useChatStore} from '../src/store/chat';
import {useSessionsStore} from '../src/store/sessions';
import type {SessionListRow} from '../src/rpc/types';

const mockCall = jest.fn<Promise<unknown>, [string, Record<string, unknown>?]>();

jest.mock('../src/rpc/runtime', () => ({
  getRpc: () => ({call: mockCall}),
  setRpc: jest.fn(),
  hasRpc: () => true,
}));

function row(
  id: string,
  opts?: {namespaced?: boolean; hostProfile?: string},
): SessionListRow {
  return {
    id,
    title: '',
    preview: '',
    started_at: 0,
    message_count: 0,
    source: 'qqbot',
    ...opts,
  };
}

function rpcError(code: number, message: string): Error {
  const e = new Error(message);
  (e as {code?: number}).code = code;
  return e;
}

describe('remove 的宿主库路由（multiplex namespaced 行）', () => {
  beforeEach(() => {
    _resetChatAggregators();
    useChatStore.setState({bySession: {}});
    useSessionsStore.setState({byProfile: {}, stale: false, nsMap: null});
    mockCall.mockReset();
  });

  it('finance 列表里的 namespaced 行：delete 落宿主库 main，行从 finance 列表消失', async () => {
    useSessionsStore.setState({
      byProfile: {
        finance: [
          row('20260830_195341_abcdef01', {namespaced: true, hostProfile: 'main'}),
          row('20260901_100000_aaaaaa'),
        ],
      },
      stale: false,
    });
    mockCall.mockResolvedValue({deleted: '20260830_195341_abcdef01'});
    await useSessionsStore.getState().remove('finance', '20260830_195341_abcdef01');
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(mockCall).toHaveBeenCalledWith('session.delete', {
      session_id: '20260830_195341_abcdef01',
      profile: 'main',
    });
    expect(
      useSessionsStore.getState().byProfile.finance.some(
        r => r.id === '20260830_195341_abcdef01',
      ),
    ).toBe(false);
  });

  it('own 行（无归属标记）：delete 仍传显示 profile', async () => {
    useSessionsStore.setState({
      byProfile: {finance: [row('20260901_100000_aaaaaa')]},
      stale: false,
    });
    mockCall.mockResolvedValue({deleted: '20260901_100000_aaaaaa'});
    await useSessionsStore.getState().remove('finance', '20260901_100000_aaaaaa');
    expect(mockCall).toHaveBeenCalledWith('session.delete', {
      session_id: '20260901_100000_aaaaaa',
      profile: 'finance',
    });
  });

  it('4023 重试路径同样落宿主库：close(live sid) + delete(hostProfile)', async () => {
    useSessionsStore.setState({
      byProfile: {
        finance: [row('20260830_195341_abcdef01', {namespaced: true, hostProfile: 'main'})],
      },
      stale: false,
    });
    // 会话恰在本连接挂载（聊天菜单删除当前会话的场景）
    useChatStore.getState().attach('live9', {
      messages: [],
      profile: 'finance',
      storedSessionId: '20260830_195341_abcdef01',
      title: '',
    });
    let liveActive = true;
    mockCall.mockImplementation(async (method: string, params) => {
      if (method === 'session.delete') {
        if (liveActive) {
          throw rpcError(4023, 'cannot delete an active session');
        }
        expect(params?.profile).toBe('main');
        return {deleted: params?.session_id};
      }
      if (method === 'session.close') {
        expect(params?.session_id).toBe('live9');
        liveActive = false;
        return {closed: true};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });
    await useSessionsStore.getState().remove('finance', 'live9');
    const delCalls = mockCall.mock.calls.filter(c => c[0] === 'session.delete');
    expect(delCalls).toHaveLength(2);
    expect(
      delCalls.every(c => (c[1] as {profile: string}).profile === 'main'),
    ).toBe(true);
    expect(useSessionsStore.getState().byProfile.finance).toEqual([]);
  });

  it('namespaced 行删除失败（4007）时抛错，列表行保留', async () => {
    useSessionsStore.setState({
      byProfile: {
        finance: [row('20260830_195341_abcdef01', {namespaced: true, hostProfile: 'main'})],
      },
      stale: false,
    });
    mockCall.mockRejectedValue(rpcError(5036, 'delete failed'));
    await expect(
      useSessionsStore.getState().remove('finance', '20260830_195341_abcdef01'),
    ).rejects.toThrow('delete failed');
    expect(
      useSessionsStore.getState().byProfile.finance.some(
        r => r.id === '20260830_195341_abcdef01',
      ),
    ).toBe(true);
  });
});
