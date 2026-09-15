/**
 * 思考等级切换：
 * - /reasoning <level> 在客户端拦截改走 config.set（官方 desktop 同款路径）——
 *   服务端把它交给 slash worker 子进程执行，对 gateway live 会话不生效也不推
 *   session.info（worker 不落任何可读回状态，/title 式读回也救不了），
 *   见 docs/protocol.md §2；config.set 应用 live 会话并推 session.info，
 *   顶栏经事件路径自动同步；
 * - 裸 /reasoning、show/hide/full/clamp 显示开关、未知参数仍走 slash 流水线；
 * - setReasoningLevel 成功后本地合并 info.reasoning_effort（无 live agent 时
 *   服务端不推 session.info 的兜底）；config.set 失败在时间线记错误条。
 */

import {parseReasoningLevelArg} from '../src/rpc/slash';
import {_resetChatAggregators, useChatStore} from '../src/store/chat';

const mockCall = jest.fn<Promise<unknown>, [string, Record<string, unknown>?]>();

jest.mock('../src/rpc/runtime', () => ({
  getRpc: () => ({call: mockCall}),
  setRpc: jest.fn(),
  hasRpc: () => true,
}));

function openSession() {
  useChatStore.getState().attach('sid1', {
    messages: [],
    profile: 'main',
    storedSessionId: 'stored1',
    info: {model: 'm1', reasoning_effort: 'medium'},
  });
}

function infoOf(sid: string) {
  return useChatStore.getState().bySession[sid]?.info;
}

function systemTexts(sid: string): string[] {
  return (useChatStore.getState().bySession[sid]?.items ?? [])
    .filter(it => it.kind === 'system')
    .map(it => (it as {text?: string}).text ?? '');
}

describe('parseReasoningLevelArg', () => {
  it('纯等级', () => {
    expect(parseReasoningLevelArg('high')).toEqual({level: 'high', global: false});
  });
  it('等级 + --global（两种顺序）', () => {
    expect(parseReasoningLevelArg('high --global')).toEqual({
      level: 'high',
      global: true,
    });
    expect(parseReasoningLevelArg('--global high')).toEqual({
      level: 'high',
      global: true,
    });
  });
  it('--session 显式会话级（no-op 语义）', () => {
    expect(parseReasoningLevelArg('high --session')).toEqual({
      level: 'high',
      global: false,
    });
  });
  it('大小写归一', () => {
    expect(parseReasoningLevelArg('HIGH')).toEqual({level: 'high', global: false});
  });
  it('空参 / 显示开关 / 未知参数 / 多余 token 都返回 null', () => {
    expect(parseReasoningLevelArg('')).toBeNull();
    expect(parseReasoningLevelArg('show')).toBeNull();
    expect(parseReasoningLevelArg('hide')).toBeNull();
    expect(parseReasoningLevelArg('full')).toBeNull();
    expect(parseReasoningLevelArg('clamp')).toBeNull();
    expect(parseReasoningLevelArg('bogus')).toBeNull();
    expect(parseReasoningLevelArg('high extra')).toBeNull();
    expect(parseReasoningLevelArg('--global')).toBeNull();
  });
});

describe('/reasoning 命令拦截', () => {
  beforeEach(() => {
    _resetChatAggregators();
    useChatStore.setState({bySession: {}});
    mockCall.mockReset();
  });

  it('/reasoning high：走 config.set，不进 slash 流水线，info 即时更新', async () => {
    openSession();
    mockCall.mockResolvedValue({key: 'reasoning', value: 'high'});
    await useChatStore.getState().sendSlashCommand('sid1', '/reasoning high');
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(mockCall).toHaveBeenCalledWith('config.set', {
      key: 'reasoning',
      value: 'high',
      session_id: 'sid1',
    });
    expect(infoOf('sid1')?.reasoning_effort).toBe('high');
    // 命令回显 + 确认条（含 ✓ 与等级名，中英文案都满足）
    const texts = systemTexts('sid1');
    expect(texts).toContain('/reasoning high');
    expect(texts.some(t => t.includes('✓') && t.includes('high'))).toBe(true);
  });

  it('/reasoning high --global：config.set 带 scope:global', async () => {
    openSession();
    mockCall.mockResolvedValue({key: 'reasoning', value: 'high'});
    await useChatStore
      .getState()
      .sendSlashCommand('sid1', '/reasoning high --global');
    expect(mockCall).toHaveBeenCalledWith('config.set', {
      key: 'reasoning',
      value: 'high',
      session_id: 'sid1',
      scope: 'global',
    });
    expect(infoOf('sid1')?.reasoning_effort).toBe('high');
  });

  it('裸 /reasoning：仍走 slash.exec 查询，config.set 不被调用', async () => {
    openSession();
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'slash.exec') {
        return {output: '  Reasoning effort: medium (default)'};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });
    await useChatStore.getState().sendSlashCommand('sid1', '/reasoning');
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(mockCall).toHaveBeenCalledWith('slash.exec', {
      command: 'reasoning',
      session_id: 'sid1',
    });
    expect(infoOf('sid1')?.reasoning_effort).toBe('medium');
  });

  it.each(['/reasoning show', '/reasoning hide', '/reasoning full', '/reasoning clamp'])(
    '%s：显示开关仍走 slash 流水线',
    async cmd => {
      openSession();
      mockCall.mockImplementation(async (method: string) => {
        if (method === 'slash.exec') {
          return {output: 'ok'};
        }
        throw new Error(`unexpected rpc: ${method}`);
      });
      await useChatStore.getState().sendSlashCommand('sid1', cmd);
      expect(mockCall).toHaveBeenCalledTimes(1);
      expect(mockCall).toHaveBeenCalledWith('slash.exec', {
        command: cmd.slice(1),
        session_id: 'sid1',
      });
      expect(infoOf('sid1')?.reasoning_effort).toBe('medium');
    },
  );

  it('/reasoning bogus：未知参数仍走 slash 流水线（服务端报用法）', async () => {
    openSession();
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'slash.exec') {
        return {output: '  Unknown argument: bogus'};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });
    await useChatStore.getState().sendSlashCommand('sid1', '/reasoning bogus');
    expect(mockCall).toHaveBeenCalledWith('slash.exec', {
      command: 'reasoning bogus',
      session_id: 'sid1',
    });
    expect(infoOf('sid1')?.reasoning_effort).toBe('medium');
  });

  it('config.set 失败：时间线记错误条，info 不变', async () => {
    openSession();
    mockCall.mockRejectedValue(new Error('unknown reasoning value'));
    await useChatStore.getState().sendSlashCommand('sid1', '/reasoning high');
    expect(infoOf('sid1')?.reasoning_effort).toBe('medium');
    expect(
      systemTexts('sid1').some(t => t.includes('unknown reasoning value')),
    ).toBe(true);
  });
});

describe('setReasoningLevel / fetchReasoningLevel', () => {
  beforeEach(() => {
    _resetChatAggregators();
    useChatStore.setState({bySession: {}});
    mockCall.mockReset();
  });

  it('setReasoningLevel：无 info 时本地新建合并（无 live agent 的兜底）', async () => {
    useChatStore.getState().attach('sid2', {
      messages: [],
      profile: 'main',
      storedSessionId: 'stored2',
    });
    mockCall.mockResolvedValue({key: 'reasoning', value: 'low'});
    await useChatStore.getState().setReasoningLevel('sid2', 'low');
    expect(mockCall).toHaveBeenCalledWith('config.set', {
      key: 'reasoning',
      value: 'low',
      session_id: 'sid2',
    });
    expect(infoOf('sid2')?.reasoning_effort).toBe('low');
  });

  it('setReasoningLevel：config.set 抛错时不做本地合并', async () => {
    openSession();
    mockCall.mockRejectedValue(new Error('session not found'));
    await expect(
      useChatStore.getState().setReasoningLevel('sid1', 'high'),
    ).rejects.toThrow('session not found');
    expect(infoOf('sid1')?.reasoning_effort).toBe('medium');
  });

  it('fetchReasoningLevel：读回 config.get 的 value', async () => {
    mockCall.mockResolvedValue({value: 'xhigh', display: 'show'});
    await expect(
      useChatStore.getState().fetchReasoningLevel('sid1'),
    ).resolves.toBe('xhigh');
    expect(mockCall).toHaveBeenCalledWith('config.get', {
      key: 'reasoning',
      session_id: 'sid1',
    });
  });

  it('fetchReasoningLevel：缺字段兜底空串', async () => {
    mockCall.mockResolvedValue({});
    await expect(
      useChatStore.getState().fetchReasoningLevel('sid1'),
    ).resolves.toBe('');
  });
});
