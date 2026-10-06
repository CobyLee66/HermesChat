/**
 * 后台渲染闸门（chat store）：App 切后台后 snapshot/usage 攒批不发射
 * （bySession 引用不变 = 零渲染，聚合器照常收事件），回前台一次性重放到
 * 最新；busy 补丁被后续无补丁快照作废；reattach 的结构字段不受闸门影响
 * （后台重连链 resumeActiveSessions 依赖 key/profile/storedSessionId）。
 */
import {
  _resetChatAggregators,
  _setChatUiForeground,
  useChatStore,
} from '../src/store/chat';
import type {AssistantMsg, ClarifyCardItem} from '../src/rpc/types';

const mockCall = jest.fn<Promise<unknown>, [string, Record<string, unknown>?]>();

jest.mock('../src/rpc/runtime', () => ({
  getRpc: () => ({call: mockCall}),
  setRpc: jest.fn(),
  hasRpc: () => true,
}));

const SID = 'sid-bg';

function attachSession() {
  useChatStore.getState().attach(SID, {
    messages: [{role: 'user', text: '你好'}],
    profile: 'main',
    storedSessionId: 'stored-bg',
  });
}

describe('后台渲染闸门', () => {
  beforeEach(() => {
    _resetChatAggregators();
    useChatStore.setState({bySession: {}});
    // message.complete（inflight 投影尾部）会触发 session.history 重拉
    mockCall.mockReset().mockResolvedValue({messages: []});
  });
  afterEach(() => {
    // 兜底回前台，避免跨用例残留后台态
    _setChatUiForeground(true);
  });

  it('前台：delta 立即落到 store（回归基准）', () => {
    attachSession();
    useChatStore.getState().applyEvent(SID, 'message.start', {});
    useChatStore.getState().applyEvent(SID, 'message.delta', {text: '你'});
    const st = useChatStore.getState().bySession[SID];
    const tail = st.items[st.items.length - 1] as AssistantMsg;
    expect(tail.blocks).toEqual([{type: 'text', text: '你'}]);
    expect(st.busy).toBe(true);
  });

  it('后台：delta 攒批不发射（引用不变），回前台一次重放到最新', () => {
    attachSession();
    const before = useChatStore.getState().bySession[SID];
    _setChatUiForeground(false);
    useChatStore.getState().applyEvent(SID, 'message.start', {});
    useChatStore.getState().applyEvent(SID, 'message.delta', {text: '你'});
    useChatStore.getState().applyEvent(SID, 'message.delta', {text: '好'});
    // 后台期间 store 零发射
    expect(useChatStore.getState().bySession[SID]).toBe(before);
    _setChatUiForeground(true);
    const after = useChatStore.getState().bySession[SID];
    expect(after).not.toBe(before);
    const tail = after.items[after.items.length - 1] as AssistantMsg;
    expect(tail.blocks).toEqual([{type: 'text', text: '你好'}]);
    expect(after.busy).toBe(true);
  });

  it('后台期间 clarify.request 不丢，回前台卡片落时间线', () => {
    attachSession();
    _setChatUiForeground(false);
    useChatStore.getState().applyEvent(SID, 'clarify.request', {
      request_id: 'r1',
      question: '选哪个？',
      choices: ['甲', '乙'],
    });
    expect(
      useChatStore
        .getState()
        .bySession[SID].items.some(i => i.kind === 'clarify'),
    ).toBe(false);
    _setChatUiForeground(true);
    const card = useChatStore
      .getState()
      .bySession[SID].items.find(i => i.kind === 'clarify') as
      | ClarifyCardItem
      | undefined;
    expect(card).toMatchObject({kind: 'clarify', requestId: 'r1'});
    expect(card?.questions).toEqual([
      {qid: '', question: '选哪个？', choices: ['甲', '乙'], multiSelect: false},
    ]);
  });

  it('后台攒批的 busy 补丁被后续无补丁快照作废（turn 后台结束不残留 busy:true）', () => {
    _setChatUiForeground(false);
    // 后台 attach（resume 完成于后台的场景）：patch 带 busy:true
    useChatStore.getState().attach(SID, {
      messages: [{role: 'user', text: 'q'}],
      profile: 'main',
      storedSessionId: 's',
      running: true,
      inflight: {user: 'q', assistant: '答', streaming: true},
    });
    useChatStore.getState().applyEvent(SID, 'message.delta', {text: '中'});
    useChatStore.getState().applyEvent(SID, 'message.complete', {text: '答中'});
    _setChatUiForeground(true);
    const st = useChatStore.getState().bySession[SID];
    // 若无作废规则，attach 攒下的 busy:true 会在重放时盖掉 complete 的结果
    expect(st.busy).toBe(false);
  });

  it('后台攒批无后续快照时 busy 补丁保留（attach running 语义不丢）', () => {
    _setChatUiForeground(false);
    // running:true 但无 inflight：聚合器 isStreaming=false，只有补丁能表达 busy
    useChatStore.getState().attach(SID, {
      messages: [{role: 'user', text: 'q'}],
      profile: 'main',
      storedSessionId: 's',
      running: true,
    });
    _setChatUiForeground(true);
    expect(useChatStore.getState().bySession[SID].busy).toBe(true);
  });

  it('后台 session.usage 不发射，回前台只合最新值', () => {
    attachSession();
    const before = useChatStore.getState().bySession[SID];
    _setChatUiForeground(false);
    useChatStore.getState().applyEvent(SID, 'session.usage', {
      usage: {total_tokens: 100},
    });
    useChatStore.getState().applyEvent(SID, 'session.usage', {
      usage: {total_tokens: 260, model: 'm2'},
    });
    expect(useChatStore.getState().bySession[SID]).toBe(before);
    _setChatUiForeground(true);
    const st = useChatStore.getState().bySession[SID];
    expect(st).not.toBe(before);
    expect(st.info?.usage).toEqual({total_tokens: 260, model: 'm2'});
  });

  it('后台 reattach：key/结构字段立即落，items 延迟到前台重放', () => {
    attachSession();
    _setChatUiForeground(false);
    useChatStore.getState().reattachAfterResume(SID, 'live2', {
      messages: [
        {role: 'user', text: '你好'},
        {role: 'assistant', text: '你好！新'},
      ],
      running: false,
    });
    const mid = useChatStore.getState().bySession;
    // key 与结构字段立即存在（后台重连链可迭代、页面可跟随迁移）
    expect(mid[SID].migratedTo).toBe('live2');
    expect(mid.live2).toBeDefined();
    expect(mid.live2.profile).toBe('main');
    expect(mid.live2.storedSessionId).toBe('stored-bg');
    // items 仍是旧快照引用（后台零挂载）
    expect(mid.live2.items).toHaveLength(1);
    _setChatUiForeground(true);
    const after = useChatStore.getState().bySession.live2;
    expect(after.items).toHaveLength(2);
    expect(after.busy).toBe(false);
  });

  it('detach 清掉攒批：后台事件 + detach 后回前台不复活该会话', () => {
    attachSession();
    _setChatUiForeground(false);
    useChatStore.getState().applyEvent(SID, 'message.start', {});
    useChatStore.getState().applyEvent(SID, 'message.delta', {text: 'x'});
    useChatStore.getState().detach(SID);
    _setChatUiForeground(true);
    expect(useChatStore.getState().bySession[SID]).toBeUndefined();
  });

  it('reattach running:true 且无 inflight：busy 不被聚合器重算打掉（前台/后台一致）', () => {
    attachSession();
    // 前台路径
    useChatStore.getState().reattachAfterResume(SID, SID, {
      messages: [{role: 'user', text: '你好'}],
      running: true,
    });
    expect(useChatStore.getState().bySession[SID].busy).toBe(true);
    // 后台路径
    _setChatUiForeground(false);
    useChatStore.getState().reattachAfterResume(SID, SID, {
      messages: [{role: 'user', text: '你好'}],
      running: true,
    });
    _setChatUiForeground(true);
    expect(useChatStore.getState().bySession[SID].busy).toBe(true);
  });
});
