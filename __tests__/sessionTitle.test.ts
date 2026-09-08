/**
 * 会话标题即时刷新：
 * - /title 命令由服务端 slash worker 直接写库，**不推 session.title/session.info
 *   事件**（见 docs/protocol.md §2）→ 客户端执行后主动读回 `session.title` 只读形式；
 * - 首轮自动命名走 `session.title` 事件、改名 RPC 走 `session.info` 事件 → 同样落地；
 * - 落地目标两处：chat store（顶栏标题）+ sessions store 列表行（就地回填）。
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

function row(id: string, title: string): SessionListRow {
  return {
    id,
    title,
    preview: '',
    started_at: 0,
    message_count: 0,
    source: 'tui',
  };
}

/** 打开一个会话：列表里已有 stored1，头部种子标题为「旧标题」 */
function openSession() {
  useSessionsStore.setState({
    byProfile: {main: [row('stored1', '旧标题'), row('stored2', '别的会话')]},
    stale: false,
  });
  useChatStore.getState().attach('sid1', {
    messages: [],
    profile: 'main',
    storedSessionId: 'stored1',
    title: '旧标题',
  });
}

function titleOf(sid: string): string | undefined {
  return useChatStore.getState().bySession[sid]?.title;
}

describe('会话标题即时刷新', () => {
  beforeEach(() => {
    _resetChatAggregators();
    useChatStore.setState({bySession: {}});
    useSessionsStore.setState({byProfile: {}, stale: false, nsMap: null});
    mockCall.mockReset();
  });

  it('session.title 事件（首轮自动命名）：头部 + 列表行同步', () => {
    openSession();
    // 事件帧 key 是 live sid（wireEvents 传入），payload.session_id 是持久化 id
    useChatStore.getState().applyEvent('sid1', 'session.title', {
      session_id: 'stored1',
      title: '自动命名后的标题',
    });
    expect(titleOf('sid1')).toBe('自动命名后的标题');
    const rows = useSessionsStore.getState().byProfile.main;
    expect(rows[0].title).toBe('自动命名后的标题');
    expect(rows[1].title).toBe('别的会话');
  });

  it('session.title 事件缺 payload.session_id：用本地持久化 id 回填', () => {
    openSession();
    useChatStore.getState().applyEvent('sid1', 'session.title', {
      title: '只有标题',
    });
    expect(titleOf('sid1')).toBe('只有标题');
    expect(useSessionsStore.getState().byProfile.main[0].title).toBe('只有标题');
  });

  it('session.info 事件带 title：同样刷新（改名 RPC 的 info 广播）', () => {
    openSession();
    useChatStore.getState().applyEvent('sid1', 'session.info', {
      model: 'm',
      title: 'info 里的标题',
      stored_session_id: 'stored1',
    });
    expect(titleOf('sid1')).toBe('info 里的标题');
    expect(useSessionsStore.getState().byProfile.main[0].title).toBe(
      'info 里的标题',
    );
  });

  it('空标题不落地（服务端未落库时不得抹掉已有标题）', () => {
    openSession();
    useChatStore.getState().applyEvent('sid1', 'session.title', {
      session_id: 'stored1',
      title: '   ',
    });
    expect(titleOf('sid1')).toBe('旧标题');
    expect(useSessionsStore.getState().byProfile.main[0].title).toBe('旧标题');
  });

  it('refreshTitle：读回 session.title（只读形式）并落地到两处', async () => {
    openSession();
    mockCall.mockResolvedValue({title: '读回的标题', session_key: 'stored1'});
    await useChatStore.getState().refreshTitle('sid1');
    expect(mockCall).toHaveBeenCalledWith('session.title', {
      session_id: 'sid1',
    });
    expect(titleOf('sid1')).toBe('读回的标题');
    expect(useSessionsStore.getState().byProfile.main[0].title).toBe('读回的标题');
  });

  it('/title 命令：执行后自动读回，头部与列表立即刷新', async () => {
    openSession();
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'slash.exec') {
        return {output: '  Session title set: 新名字'};
      }
      if (method === 'session.title') {
        return {title: '新名字', session_key: 'stored1'};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });
    await useChatStore.getState().sendSlashCommand('sid1', '/title 新名字');
    expect(mockCall).toHaveBeenCalledWith('session.title', {
      session_id: 'sid1',
    });
    expect(titleOf('sid1')).toBe('新名字');
    expect(useSessionsStore.getState().byProfile.main[0].title).toBe('新名字');
  });

  it('/title 命令失败（改名未生效）：读回旧标题，不产生假更新', async () => {
    openSession();
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'slash.exec') {
        return {output: "  Title '新名字' is already in use by session x"};
      }
      if (method === 'session.title') {
        return {title: '旧标题', session_key: 'stored1'};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });
    await useChatStore.getState().sendSlashCommand('sid1', '/title 新名字');
    expect(titleOf('sid1')).toBe('旧标题');
    expect(useSessionsStore.getState().byProfile.main[0].title).toBe('旧标题');
  });

  it('非 /title 命令不触发标题读回', async () => {
    openSession();
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'slash.exec') {
        return {output: 'ok'};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });
    await useChatStore.getState().sendSlashCommand('sid1', '/status');
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(mockCall).toHaveBeenCalledWith('slash.exec', {
      command: 'status',
      session_id: 'sid1',
    });
  });

  it('refreshTitle 读回失败：静默保持旧标题（不弹错误条）', async () => {
    openSession();
    mockCall.mockRejectedValue(new Error('session not found'));
    await expect(
      useChatStore.getState().refreshTitle('sid1'),
    ).resolves.toBeUndefined();
    expect(titleOf('sid1')).toBe('旧标题');
  });

  it('patchTitle：命中多个 profile 列表行；行不在任何列表则置脏', () => {
    useSessionsStore.setState({
      byProfile: {
        main: [row('stored1', '旧'), row('stored2', '别的')],
        work: [row('stored1', '旧'), row('stored3', '第三个')],
      },
      stale: false,
    });
    useSessionsStore.getState().patchTitle('stored1', '新');
    const st = useSessionsStore.getState();
    expect(st.byProfile.main[0].title).toBe('新');
    expect(st.byProfile.main[1].title).toBe('别的');
    expect(st.byProfile.work[0].title).toBe('新');
    expect(st.stale).toBe(false);

    useSessionsStore.getState().patchTitle('stored404', '无此行');
    expect(useSessionsStore.getState().stale).toBe(true);
  });

  it('patchTitle：标题未变时保持引用稳定（不触发无谓重渲染）', () => {
    useSessionsStore.setState({
      byProfile: {main: [row('stored1', '一样')]},
      stale: false,
    });
    const before = useSessionsStore.getState().byProfile;
    useSessionsStore.getState().patchTitle('stored1', '一样');
    expect(useSessionsStore.getState().byProfile).toBe(before);
    expect(useSessionsStore.getState().stale).toBe(false);
  });

  it('renameSession：session.title 写形式改名，服务端 sanitize 值落地两处', async () => {
    openSession();
    mockCall.mockResolvedValue({pending: false, title: '服务端标题'});
    await useChatStore.getState().renameSession('sid1', '  新名字  ');
    expect(mockCall).toHaveBeenCalledWith('session.title', {
      session_id: 'sid1',
      title: '新名字',
    });
    expect(titleOf('sid1')).toBe('服务端标题');
    expect(useSessionsStore.getState().byProfile.main[0].title).toBe(
      '服务端标题',
    );
  });

  it('renameSession：结果缺 title 时用提交值落地', async () => {
    openSession();
    mockCall.mockResolvedValue({pending: false});
    await useChatStore.getState().renameSession('sid1', '提交值');
    expect(titleOf('sid1')).toBe('提交值');
    expect(useSessionsStore.getState().byProfile.main[0].title).toBe('提交值');
  });

  it('renameSession：空标题直接跳过，不调 RPC', async () => {
    openSession();
    await useChatStore.getState().renameSession('sid1', '   ');
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('renameSession：RPC 失败时抛错（调用方提示），本地标题不变', async () => {
    openSession();
    mockCall.mockRejectedValue(new Error('4022: title too long'));
    await expect(
      useChatStore.getState().renameSession('sid1', '新名字'),
    ).rejects.toThrow('4022');
    expect(titleOf('sid1')).toBe('旧标题');
    expect(useSessionsStore.getState().byProfile.main[0].title).toBe('旧标题');
  });

  it('remove（聊天菜单传 live sid）：归一化为 close(live)+delete(持久化id)，行按持久化 id 过滤', async () => {
    openSession();
    let liveActive = true;
    mockCall.mockImplementation(async (method: string, params) => {
      if (method === 'session.delete') {
        if (params?.session_id === 'stored1') {
          if (liveActive) {
            const e = new Error('cannot delete an active session');
            (e as {code?: number}).code = 4023;
            throw e;
          }
          return {deleted: 'stored1'};
        }
        // live sid / 未知 id：真实网关按持久化 id 查库，一律 4007
        const e = new Error('session not found');
        (e as {code?: number}).code = 4007;
        throw e;
      }
      if (method === 'session.close') {
        if (params?.session_id === 'sid1') {
          liveActive = false;
          return {closed: true};
        }
        return {closed: false};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });
    await useSessionsStore.getState().remove('main', 'sid1');
    const delCalls = mockCall.mock.calls.filter(c => c[0] === 'session.delete');
    expect(delCalls).toHaveLength(2);
    expect(delCalls.every(c => (c[1] as {session_id: string}).session_id === 'stored1')).toBe(true);
    expect(mockCall).toHaveBeenCalledWith('session.close', {session_id: 'sid1'});
    // 列表行按持久化 id 过滤：stored1 消失（按 live sid 过滤会漏），别的行不动
    const rows1 = useSessionsStore.getState().byProfile.main;
    expect(rows1.some(r => r.id === 'stored1')).toBe(false);
    expect(rows1.map(r => r.id)).toEqual(['stored2']);
  });

  it('remove（列表传持久化 id、会话挂载中）：同样能 close(live) 后删掉', async () => {
    openSession();
    let liveActive = true;
    mockCall.mockImplementation(async (method: string, params) => {
      if (method === 'session.delete') {
        if (params?.session_id === 'stored1' && !liveActive) {
          return {deleted: 'stored1'};
        }
        const e = new Error('cannot delete an active session');
        (e as {code?: number}).code = 4023;
        throw e;
      }
      if (method === 'session.close') {
        if (params?.session_id === 'sid1') {
          liveActive = false;
          return {closed: true};
        }
        return {closed: false};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });
    await useSessionsStore.getState().remove('main', 'stored1');
    expect(mockCall).toHaveBeenCalledWith('session.close', {session_id: 'sid1'});
    const rows2 = useSessionsStore.getState().byProfile.main;
    expect(rows2.some(r => r.id === 'stored1')).toBe(false);
    expect(rows2.map(r => r.id)).toEqual(['stored2']);
  });

  it('remove（非活动会话）：单次 delete(stored) 成功', async () => {
    openSession();
    useChatStore.setState({bySession: {}});
    mockCall.mockResolvedValue({deleted: 'stored1'});
    await useSessionsStore.getState().remove('main', 'stored1');
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(mockCall).toHaveBeenCalledWith('session.delete', {
      session_id: 'stored1',
      profile: 'main',
    });
    expect(
      useSessionsStore.getState().byProfile.main.some(r => r.id === 'stored1'),
    ).toBe(false);
  });
});
