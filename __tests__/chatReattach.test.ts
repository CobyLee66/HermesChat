/**
 * chat store 重进会话（attach 重建）行为：
 * 服务端历史为权威——resume 快路径返回同一 live sid 时，重进必须重建时间线
 * 而不是沿用首次进入的旧快照；running/inflight 恢复流式尾部。
 */
import {_resetChatAggregators, useChatStore} from '../src/store/chat';
import type {AssistantMsg, ProjectedMessage} from '../src/rpc/types';

function history(): ProjectedMessage[] {
  return [
    {role: 'user', text: '你好'},
    {role: 'assistant', text: '你好！'},
  ];
}

describe('chat store attach 重建', () => {
  beforeEach(() => {
    _resetChatAggregators();
    useChatStore.setState({bySession: {}});
  });

  it('首次进入：hydrate 历史', () => {
    useChatStore.getState().attach('sid1', {
      messages: history(),
      profile: 'main',
      storedSessionId: 'stored1',
    });
    const st = useChatStore.getState().bySession['sid1'];
    expect(st.items).toHaveLength(2);
    expect(st.busy).toBe(false);
  });

  it('重进（同一 live sid）：以服务端消息重建，不沿用旧快照', () => {
    useChatStore.getState().attach('sid1', {
      messages: history(),
      profile: 'main',
      storedSessionId: 'stored1',
    });
    // 其它端（dashboard/QQ）续聊了两条
    const grown: ProjectedMessage[] = [
      ...history(),
      {role: 'user', text: '继续'},
      {role: 'assistant', text: '好的'},
    ];
    useChatStore.getState().attach('sid1', {
      messages: grown,
      profile: 'main',
      storedSessionId: 'stored1',
    });
    const st = useChatStore.getState().bySession['sid1'];
    expect(st.items).toHaveLength(4);
    expect(
      st.items.map(i => (i.kind === 'user' || i.kind === 'assistant' ? i : null)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({kind: 'user', text: '继续'}),
        expect.objectContaining({kind: 'assistant'}),
      ]),
    );
  });

  it('running turn：重进后恢复流式尾部，busy=true，后续事件续流', () => {
    useChatStore.getState().attach('sid1', {
      messages: [...history(), {role: 'user', text: '改文件'}],
      profile: 'main',
      storedSessionId: 'stored1',
      running: true,
      inflight: {user: '改文件', assistant: '正在写', streaming: true},
    });
    const st = useChatStore.getState().bySession['sid1'];
    expect(st.busy).toBe(true);
    const tail = st.items[st.items.length - 1] as AssistantMsg;
    expect(tail.streaming).toBe(true);
    // 事件继续流入：delta 接在恢复的尾部
    useChatStore.getState().applyEvent('sid1', 'message.delta', {text: '…完成'});
    const after = useChatStore.getState().bySession['sid1'];
    const tailAfter = after.items[after.items.length - 1] as AssistantMsg;
    expect(tailAfter.blocks).toEqual([{type: 'text', text: '正在写…完成'}]);
    // thinking.delta 占位进状态字段而非正文
    useChatStore.getState().applyEvent('sid1', 'thinking.delta', {
      text: '(´･_･`) processing...',
    });
    const hinted = useChatStore.getState().bySession['sid1'];
    expect(hinted.thinkingHint).toBe('(´･_･`) processing...');
    expect(hinted.items[hinted.items.length - 1]).toBe(tailAfter);
  });

  it('重进时本地流式尾部（同一 turn）保留工具卡', () => {
    useChatStore.getState().attach('sid1', {
      messages: history(),
      profile: 'main',
      storedSessionId: 'stored1',
    });
    // 本地开始一轮 turn：文本 + 工具
    useChatStore.getState().applyEvent('sid1', 'message.start', {});
    useChatStore.getState().applyEvent('sid1', 'message.delta', {text: '部分'});
    useChatStore
      .getState()
      .applyEvent('sid1', 'tool.start', {
        tool_id: 't1',
        name: 'write_file',
        context: 'src/a.ts',
      });
    // 用户退到列表再重进（服务端 turn 还在跑）
    useChatStore.getState().attach('sid1', {
      messages: history(),
      profile: 'main',
      storedSessionId: 'stored1',
      running: true,
      inflight: {user: '你好', assistant: '部分更长', streaming: true},
    });
    const st = useChatStore.getState().bySession['sid1'];
    const tail = st.items[st.items.length - 1] as AssistantMsg;
    expect(tail.streaming).toBe(true);
    expect(
      tail.blocks.some(
        b => b.type === 'tool' && b.tool.toolId === 't1',
      ),
    ).toBe(true);
  });

  it('reattachAfterResume：live sid 迁移 + running 恢复流式尾部', () => {
    useChatStore.getState().attach('oldSid', {
      messages: history(),
      profile: 'main',
      storedSessionId: 'stored1',
    });
    useChatStore.getState().applyEvent('oldSid', 'message.start', {});
    useChatStore.getState().applyEvent('oldSid', 'message.delta', {text: '半'});
    useChatStore.getState().reattachAfterResume('oldSid', 'newSid', {
      messages: [...history(), {role: 'user', text: '你好'}] as ProjectedMessage[],
      running: true,
      inflight: {user: '你好', assistant: '半成品', streaming: true},
    });
    const s = useChatStore.getState().bySession;
    expect(s.oldSid).toBeUndefined();
    expect(s.newSid.busy).toBe(true);
    const tail = s.newSid.items[s.newSid.items.length - 1] as AssistantMsg;
    expect(tail.blocks).toEqual([{type: 'text', text: '半成品'}]);
  });
});
