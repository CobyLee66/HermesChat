/**
 * live sid 失效后的发送自愈（2026-09-16 报障修复）：
 * - 长时间停留后隧道断开重连，resume 冷路径换新 live sid，旧 key 被
 *   reattachAfterResume 整体删除 → 挂载中的聊天页读到 undefined（历史
 *   「消失」）、发送仍打旧 sid 报「session not found」→ 现保留 shell +
 *   migratedTo 让页面跟随；
 * - 新建空会话等待期间被回收：服务端首次 prompt 前不落库，resume 必
 *   4007、列表不可见（重进无门）→ 发送时 session.create 重建；
 * - session.reclaimed 是全局广播（帧级无 session_id），接线后置 staleLive，
 *   下次发送跳过必败首发直接自愈。
 */

import {RpcError} from '../src/rpc/client';
import {_resetChatAggregators, useChatStore} from '../src/store/chat';
import {
  _resetConnectionTimers,
  useConnectionStore,
} from '../src/store/connection';
import {useSessionsStore} from '../src/store/sessions';
import type {ProjectedMessage} from '../src/rpc/types';
import type {SessionChatState} from '../src/store/chat';

const mockCall = jest.fn<Promise<unknown>, [string, Record<string, unknown>?]>();

jest.mock('../src/rpc/runtime', () => ({
  getRpc: () => ({call: mockCall}),
  setRpc: jest.fn(),
  hasRpc: () => true,
}));

function seed(overrides: Partial<SessionChatState> = {}): SessionChatState {
  return {
    items: [],
    status: null,
    thinkingHint: null,
    info: null,
    busy: false,
    profile: 'main',
    storedSessionId: 'stored1',
    foreign: null,
    pendingAttachments: [],
    ...overrides,
  };
}

function seedSession(sid: string, overrides: Partial<SessionChatState> = {}) {
  useChatStore.setState(s => ({
    bySession: {...s.bySession, [sid]: seed(overrides)},
  }));
}

function userTexts(sid: string): string[] {
  const items = useChatStore.getState().bySession[sid]?.items ?? [];
  return items.filter(it => it.kind === 'user').map(it => it.text);
}

function systemTexts(sid: string): string[] {
  const items = useChatStore.getState().bySession[sid]?.items ?? [];
  return items.filter(it => it.kind === 'system').map(it => it.text);
}

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

describe('reattachAfterResume：live sid 变化时的迁移', () => {
  it('sid 变化：旧 key 保留 shell + migratedTo，新 key 装完整状态', () => {
    seedSession('s1', {
      title: '旧标题',
      storedSessionId: 'stored1',
      pendingFirstSubmit: true,
      busy: true,
    });
    const messages: ProjectedMessage[] = [
      {role: 'user', text: '历史消息'},
      {role: 'assistant', text: '历史回复'},
    ];
    useChatStore.getState().reattachAfterResume('s1', 's2', {messages});

    const shell = useChatStore.getState().bySession.s1;
    expect(shell?.migratedTo).toBe('s2');
    expect(shell?.busy).toBe(false);

    const next = useChatStore.getState().bySession.s2;
    expect(next.storedSessionId).toBe('stored1');
    expect(next.title).toBe('旧标题');
    expect(next.pendingFirstSubmit).toBe(true);
    expect(next.migratedTo).toBeUndefined();
    expect(next.staleLive).toBe(false);
    expect(userTexts('s2')).toEqual(['历史消息']);
  });

  it('sid 不变（快路径）：原地重建，不设 migratedTo（回归保护）', () => {
    seedSession('s1', {title: '标题'});
    useChatStore.getState().reattachAfterResume('s1', 's1', {
      messages: [{role: 'user', text: '新历史'}],
    });
    expect(useChatStore.getState().bySession.s1?.migratedTo).toBeUndefined();
    expect(userTexts('s1')).toEqual(['新历史']);
  });
});

describe('发送自愈：prompt.submit 撞 4007', () => {
  it('resume 成功换新 sid → 在新 sid 重发，旧 key 标 migratedTo', async () => {
    seedSession('s1', {storedSessionId: 'stored1', title: '标题'});
    mockCall.mockImplementation(async (method, params) => {
      if (method === 'prompt.submit') {
        if (params?.session_id === 's1') {
          throw new RpcError(4007, 'session not found');
        }
        return {status: 'streaming'};
      }
      if (method === 'session.resume') {
        expect(params).toMatchObject({session_id: 'stored1', profile: 'main'});
        return {
          session_id: 's2',
          stored_session_id: 'stored1',
          running: false,
          messages: [{role: 'user', text: '旧历史'}],
        };
      }
      throw new Error(`unexpected rpc: ${method}`);
    });

    await useChatStore.getState().sendPrompt('s1', '你好');

    const submits = mockCall.mock.calls.filter(c => c[0] === 'prompt.submit');
    expect(submits).toHaveLength(2);
    expect(submits[1][1]?.session_id).toBe('s2');
    expect(useChatStore.getState().bySession.s1?.migratedTo).toBe('s2');
    // 服务端历史 + 新气泡各一次（失败那次落在旧聚合器的气泡已丢弃，不重复）
    expect(userTexts('s2')).toEqual(['旧历史', '你好']);
    expect(systemTexts('s2').join('\n')).toContain('自动恢复');
  });

  it('resume 也 4007 + 空会话 → session.create 重建后发送成功', async () => {
    seedSession('s1', {
      storedSessionId: 'stored1',
      title: '新会话',
      pendingFirstSubmit: true,
    });
    mockCall.mockImplementation(async (method, params) => {
      if (method === 'prompt.submit') {
        if (params?.session_id === 's1') {
          throw new RpcError(4007, 'session not found');
        }
        return {status: 'streaming'};
      }
      if (method === 'session.resume') {
        throw new RpcError(4007, 'session not found');
      }
      if (method === 'session.create') {
        return {
          session_id: 's2',
          stored_session_id: 'stored2',
          messages: [],
          info: {model: 'mock-model'},
        };
      }
      throw new Error(`unexpected rpc: ${method}`);
    });

    await useChatStore.getState().sendPrompt('s1', '第一条消息');

    expect(mockCall).toHaveBeenCalledWith(
      'session.create',
      expect.objectContaining({profile: 'main', title: '新会话'}),
    );
    expect(useChatStore.getState().bySession.s1?.migratedTo).toBe('s2');
    expect(useChatStore.getState().bySession.s2?.storedSessionId).toBe(
      'stored2',
    );
    expect(userTexts('s2')).toEqual(['第一条消息']);
    // 首条消息发出后空会话窗口关闭 + 列表置 stale（重拉可见新会话）
    expect(useChatStore.getState().bySession.s2?.pendingFirstSubmit).toBe(
      false,
    );
    expect(useSessionsStore.getState().stale).toBe(true);
  });

  it('resume 4007 + 非空会话：不重建，落发送失败红条', async () => {
    seedSession('s1', {storedSessionId: 'stored1'});
    mockCall.mockImplementation(async (method, params) => {
      if (method === 'prompt.submit' && params?.session_id === 's1') {
        throw new RpcError(4007, 'session not found');
      }
      if (method === 'session.resume') {
        throw new RpcError(4007, 'session not found');
      }
      throw new Error(`unexpected rpc: ${method}`);
    });

    await useChatStore.getState().sendPrompt('s1', 'hello');

    expect(mockCall).not.toHaveBeenCalledWith('session.create', expect.anything());
    expect(systemTexts('s1').join('\n')).toContain('session not found');
  });

  it('非 4007 错误（网络等）：不自愈，维持原有红条', async () => {
    seedSession('s1', {storedSessionId: 'stored1'});
    mockCall.mockImplementation(async method => {
      if (method === 'prompt.submit') {
        throw new Error('connection lost');
      }
      throw new Error(`unexpected rpc: ${method}`);
    });

    await useChatStore.getState().sendPrompt('s1', 'hello');

    expect(mockCall).not.toHaveBeenCalledWith('session.resume', expect.anything());
    expect(systemTexts('s1').join('\n')).toContain('connection lost');
  });
});

describe('session.reclaimed 接线与 staleLive 快路径', () => {
  it('按 live sid 命中：置 staleLive + busy=false，不打扰 UI', () => {
    seedSession('s1', {busy: true});
    useChatStore.getState().markSessionReclaimed('s1', 'stored1', 'ws_orphan_reap');
    const st = useChatStore.getState().bySession.s1;
    expect(st?.staleLive).toBe(true);
    expect(st?.busy).toBe(false);
    expect(st?.resumeFailed).toBeFalsy();
  });

  it('key 不匹配时按 storedSessionId 兜底（迁移后 key 已换）', () => {
    seedSession('s9', {storedSessionId: 'stored9'});
    useChatStore.getState().markSessionReclaimed('dead-sid', 'stored9', 'idle_timeout');
    expect(useChatStore.getState().bySession.s9?.staleLive).toBe(true);
  });

  it('staleLive 快路径：跳过必败首发，直接在新会话发', async () => {
    seedSession('s1', {storedSessionId: 'stored1', staleLive: true});
    mockCall.mockImplementation(async (method, params) => {
      if (method === 'prompt.submit') {
        if (params?.session_id === 's1') {
          throw new Error('must not submit to stale sid');
        }
        return {status: 'streaming'};
      }
      if (method === 'session.resume') {
        return {
          session_id: 's2',
          stored_session_id: 'stored1',
          running: false,
          messages: [],
        };
      }
      throw new Error(`unexpected rpc: ${method}`);
    });

    await useChatStore.getState().sendPrompt('s1', 'hello');

    const submits = mockCall.mock.calls.filter(c => c[0] === 'prompt.submit');
    expect(submits).toHaveLength(1);
    expect(submits[0][1]?.session_id).toBe('s2');
    expect(userTexts('s2')).toEqual(['hello']);
  });

  it('自愈时连接未就绪：落发送失败红条（waitReady 报「未连接」）', async () => {
    seedSession('s1', {storedSessionId: 'stored1', staleLive: true});
    useConnectionStore.setState({state: 'disconnected'});

    await useChatStore.getState().sendPrompt('s1', 'hello');

    expect(mockCall).not.toHaveBeenCalled();
    expect(systemTexts('s1').join('\n')).toContain('未连接');
    expect(useChatStore.getState().bySession.s1?.busy).toBe(false);
  });
});
