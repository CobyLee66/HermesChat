/**
 * 重进会话主动同步上下文信息（syncSessionInfo）：
 * - resume 返回的 info 普遍缺 usage（计数器是 gateway 进程内状态，
 *   docs/protocol.md §3）→ 打开会话 / 重连恢复后主动调 `session.usage`
 *   只读 RPC 读回，顶栏「模型 · 上下文用量」不等新消息输出即正确；
 * - usage.model 顺带校正模型段；读回失败/缺数据静默；
 * - turn 已开始（streaming）让位：ticker 每秒推最新值，读回值必是旧的。
 */

import {_resetChatAggregators, useChatStore} from '../src/store/chat';
import {useConnectionStore} from '../src/store/connection';
import {openSessionFlow} from '../src/panels/sessionFlows';
import {useSessionsStore} from '../src/store/sessions';
import type {SessionListRow, UsageInfo} from '../src/rpc/types';

const mockCall = jest.fn<Promise<unknown>, [string, Record<string, unknown>?]>();

jest.mock('../src/rpc/runtime', () => ({
  getRpc: () => ({call: mockCall}),
  setRpc: jest.fn(),
  hasRpc: () => true,
}));

/** fire-and-forget 的读回是异步的：等微任务+定时器清空后再断言 */
const flush = () => new Promise<void>(r => setTimeout(() => r(), 0));

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

const USAGE: UsageInfo = {
  model: '新模型',
  input: 2100,
  output: 1350,
  total: 3450,
  calls: 2,
  context_used: 3450,
  context_max: 8000,
  context_percent: 43,
};

function infoOf(sid: string) {
  return useChatStore.getState().bySession[sid]?.info;
}

describe('重进会话主动同步上下文信息', () => {
  beforeEach(() => {
    _resetChatAggregators();
    useChatStore.setState({bySession: {}});
    useSessionsStore.setState({byProfile: {}, stale: false, nsMap: null});
    // openSessionFlow 入口现在先 waitReady：种成 ready + hasRpc(mock) 直通
    useConnectionStore.setState({state: 'ready'});
    mockCall.mockReset();
  });

  it('syncSessionInfo：读回 usage 落地 info.usage，model 顺带校正', async () => {
    useChatStore.getState().attach('sid1', {
      messages: [],
      profile: 'main',
      storedSessionId: 'stored1',
      info: {model: '旧模型', reasoning_effort: 'high'},
      title: '会话',
    });
    mockCall.mockResolvedValue({...USAGE});
    await useChatStore.getState().syncSessionInfo('sid1');
    expect(mockCall).toHaveBeenCalledWith('session.usage', {
      session_id: 'sid1',
    });
    const info = infoOf('sid1');
    expect(info?.usage).toEqual(USAGE);
    expect(info?.model).toBe('新模型');
    // info 其余字段（reasoning_effort 等）合并不丢
    expect(info?.reasoning_effort).toBe('high');
  });

  it('usage 无 model（agent 未建的零计数 dict）：model 段保持不变', async () => {
    useChatStore.getState().attach('sid1', {
      messages: [],
      profile: 'main',
      storedSessionId: 'stored1',
      info: {model: '旧模型'},
      title: '会话',
    });
    mockCall.mockResolvedValue({calls: 0, input: 0, output: 0, total: 0});
    await useChatStore.getState().syncSessionInfo('sid1');
    const info = infoOf('sid1');
    expect(info?.model).toBe('旧模型');
    expect(info?.usage?.total).toBe(0);
  });

  it('返回缺 usage（非对象/空）：不落地', async () => {
    useChatStore.getState().attach('sid1', {
      messages: [],
      profile: 'main',
      storedSessionId: 'stored1',
      title: '会话',
    });
    mockCall.mockResolvedValue(undefined);
    await useChatStore.getState().syncSessionInfo('sid1');
    expect(infoOf('sid1')).toBeNull();
  });

  it('RPC 失败（服务端已回收等）：静默保持现状，不抛错', async () => {
    useChatStore.getState().attach('sid1', {
      messages: [],
      profile: 'main',
      storedSessionId: 'stored1',
      info: {model: '旧模型'},
      title: '会话',
    });
    mockCall.mockRejectedValue(new Error('4001 session not found'));
    await expect(
      useChatStore.getState().syncSessionInfo('sid1'),
    ).resolves.toBeUndefined();
    expect(infoOf('sid1')?.usage).toBeUndefined();
    expect(infoOf('sid1')?.model).toBe('旧模型');
  });

  it('turn 已开始（streaming）：让位不落地（ticker 每秒会推最新值）', async () => {
    useChatStore.getState().attach('sid1', {
      messages: [],
      profile: 'main',
      storedSessionId: 'stored1',
      title: '会话',
    });
    // 手动控制 resolve 时序：读回返回前 turn 已开始
    let resolveRpc: (v: UsageInfo) => void = () => {};
    mockCall.mockReturnValue(
      new Promise<UsageInfo>(resolve => {
        resolveRpc = resolve;
      }),
    );
    const pending = useChatStore.getState().syncSessionInfo('sid1');
    useChatStore.getState().applyEvent('sid1', 'message.start', {});
    resolveRpc({...USAGE});
    await pending;
    expect(infoOf('sid1')?.usage).toBeUndefined();
  });

  it('openSessionFlow 正常分支：打开会话后自动读回 usage', async () => {
    useSessionsStore.setState({byProfile: {main: [row('stored1')]}});
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'session.resume') {
        return {
          session_id: 'sid1',
          stored_session_id: 'stored1',
          running: false,
          messages: [],
          // 保真：resume info 缺 usage
          info: {model: 'mock-model'},
        };
      }
      if (method === 'session.usage') {
        return {...USAGE};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });
    await openSessionFlow('main', row('stored1'));
    await flush();
    expect(mockCall).toHaveBeenCalledWith('session.usage', {
      session_id: 'sid1',
    });
    expect(infoOf('sid1')?.usage).toEqual(USAGE);
  });

  it('openSessionFlow foreign 只读分支：无 live sid，不读回', async () => {
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'session.list') {
        return {sessions: []};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });
    // 不 mock exec（getExecRemote 为空）：foreign 无 fork 时报「需要 SSH」，
    // 但无论走哪条失败路径都不应出现 session.usage 调用
    await expect(
      openSessionFlow('main', {
        ...row('stored1'),
        namespaced: true,
        hostProfile: 'other',
      }),
    ).rejects.toThrow('需要 SSH');
    expect(mockCall).not.toHaveBeenCalledWith(
      'session.usage',
      expect.anything(),
    );
  });

  it('reattachAfterResume：resume info 落地（重连后模型/思考等级刷新）', () => {
    useChatStore.getState().attach('oldSid', {
      messages: [],
      profile: 'main',
      storedSessionId: 'stored1',
      info: {model: '旧模型'},
      title: '会话',
    });
    useChatStore.getState().reattachAfterResume('oldSid', 'newSid', {
      messages: [],
      info: {model: '重连后模型', reasoning_effort: 'low'},
      running: false,
    });
    const info = infoOf('newSid');
    expect(info?.model).toBe('重连后模型');
    expect(info?.reasoning_effort).toBe('low');
    // 旧 key 已迁移：保留 migratedTo shell（页面跟随），状态装到新 key
    expect(useChatStore.getState().bySession.oldSid?.migratedTo).toBe('newSid');
  });
});
