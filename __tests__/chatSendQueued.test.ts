/**
 * chat store sendPrompt 的排队排水契约（D064）：
 * - `opts.queued=true` 必须透传成 `prompt.submit {queued: true}`（服务端据此
 *   把消息排到当前轮之后，绝不打断/改写当前轮）；
 * - 返回值 = 「本条是否已被尝试发出」：排队引擎据此决定出队（true = 已消费，
 *   false = 什么都没提交，条目可安全重试）。
 */
import {_resetChatAggregators, useChatStore} from '../src/store/chat';
import {_resetDraftsForTests} from '../src/store/drafts';
import {useConnectionStore} from '../src/store/connection';

const mockCall = jest.fn<Promise<unknown>, [string, Record<string, unknown>?]>();

jest.mock('../src/rpc/runtime', () => ({
  getRpc: () => ({call: mockCall}),
  setRpc: jest.fn(),
  hasRpc: () => true,
}));

function attachIdle(sid = 's1') {
  useChatStore.getState().attach(sid, {
    messages: [],
    profile: 'main',
    storedSessionId: `stored-${sid}`,
  });
}

function items(sid = 's1') {
  return useChatStore.getState().bySession[sid].items;
}

function submitCall() {
  return mockCall.mock.calls.find(c => c[0] === 'prompt.submit');
}

beforeEach(() => {
  _resetChatAggregators();
  _resetDraftsForTests();
  mockCall.mockReset().mockResolvedValue({status: 'streaming'});
  useChatStore.setState({bySession: {}});
  useConnectionStore.setState({state: 'ready'});
});

describe('sendPrompt 排队参数与返回值', () => {
  it('queued:true 透传到 prompt.submit，返回 true（已尝试）', async () => {
    attachIdle();
    const ok = await useChatStore.getState().sendPrompt('s1', '排队消息', {
      queued: true,
    });
    expect(ok).toBe(true);
    expect(submitCall()?.[1]).toEqual({
      session_id: 's1',
      text: '排队消息',
      queued: true,
    });
  });

  it('不带 opts 时不出现 queued 参数（普通发送语义不变）', async () => {
    attachIdle();
    const ok = await useChatStore.getState().sendPrompt('s1', '普通消息');
    expect(ok).toBe(true);
    expect(submitCall()?.[1]).toEqual({session_id: 's1', text: '普通消息'});
  });

  it('空文本且无待发图片：不发 RPC，返回 false（未尝试）', async () => {
    attachIdle();
    const ok = await useChatStore.getState().sendPrompt('s1', '   ', {
      queued: true,
    });
    expect(ok).toBe(false);
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('斜杠命令走流水线（不走 prompt.submit），返回 true 视为已消费', async () => {
    attachIdle();
    mockCall.mockImplementation((method: string) => {
      if (method === 'slash.exec') {
        return Promise.resolve({output: 'ok'});
      }
      return Promise.resolve({status: 'streaming'});
    });
    const ok = await useChatStore.getState().sendPrompt('s1', '/status', {
      queued: true,
    });
    expect(ok).toBe(true);
    expect(mockCall).toHaveBeenCalledWith('slash.exec', {
      command: 'status',
      session_id: 's1',
    });
    expect(submitCall()).toBeUndefined();
  });
});

describe('sendPrompt 失败路径的返回值', () => {
  it('prompt.submit 失败：已回显用户气泡 → 返回 true（已尝试，靠错误红条呈现）', async () => {
    attachIdle();
    mockCall.mockRejectedValue(new Error('connection lost'));
    const ok = await useChatStore.getState().sendPrompt('s1', '会失败', {
      queued: true,
    });
    expect(ok).toBe(true);
    const list = items();
    expect(list.some(it => it.kind === 'user' && it.text === '会失败')).toBe(
      true,
    );
    // 未在流式中的错误落成系统红条（aggregator onError 既有口径）
    expect(
      list.some(it => it.kind === 'system' && it.eventKind === 'error'),
    ).toBe(true);
    expect(useChatStore.getState().bySession.s1.busy).toBe(false);
  });

  it('live sid 失效且自愈失败：什么都没提交 → 返回 false，条目可重试', async () => {
    attachIdle();
    useChatStore.getState().markStaleLive('s1');
    mockCall.mockImplementation((method: string) =>
      method === 'session.resume'
        ? Promise.reject(new Error('session gone'))
        : Promise.resolve({status: 'streaming'}),
    );
    const ok = await useChatStore.getState().sendPrompt('s1', '自愈失败', {
      queued: true,
    });
    expect(ok).toBe(false);
    expect(submitCall()).toBeUndefined();
    // 未尝试：不回显用户气泡（避免重试时出现重复气泡）
    expect(items().some(it => it.kind === 'user')).toBe(false);
    expect(items().some(it => it.kind === 'system')).toBe(true);
  });

  it('自愈成功：queued 参数一并带到恢复后的新会话', async () => {
    attachIdle();
    useChatStore.getState().markStaleLive('s1');
    mockCall.mockImplementation((method: string) => {
      if (method === 'session.resume') {
        return Promise.resolve({
          session_id: 's2',
          stored_session_id: 'stored-s1',
          messages: [],
          running: false,
        });
      }
      if (method === 'session.usage') {
        return Promise.resolve({total: 0});
      }
      return Promise.resolve({status: 'streaming'});
    });
    const ok = await useChatStore.getState().sendPrompt('s1', '自愈后排队', {
      queued: true,
    });
    expect(ok).toBe(true);
    expect(submitCall()?.[1]).toEqual({
      session_id: 's2',
      text: '自愈后排队',
      queued: true,
    });
  });
});
