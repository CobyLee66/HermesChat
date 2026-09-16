/**
 * resume 挂起交互（pending_approval / pending_clarify）的 wire 形态回归。
 *
 * 服务端 `_live_session_payload` 把两者塞进 resume 结果是**单个对象**
 * （server `dict | None`），不是数组；早期客户端按数组声明并直接 `for...of`，
 * 于是「clarify 挂起期间打开会话」必抛 TypeError——Android Hermes 的文案是
 * 「iterator method is not callable」，用户侧表现为「打开会话失败」，
 * clarify 超时（默认 3600s）后字段消失又能正常打开（2026-09-11 实测指纹）。
 * 这里锁死单对象/数组两种形态都能正常恢复卡片。
 */
import {_resetChatAggregators, useChatStore} from '../src/store/chat';
import {openSessionFlow} from '../src/panels/sessionFlows';
import {useConnectionStore} from '../src/store/connection';
import {useSessionsStore} from '../src/store/sessions';
import type {
  ApprovalCardItem,
  ApprovalChoice,
  ClarifyCardItem,
  SessionListRow,
} from '../src/rpc/types';

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

/** 服务端真实的单问 clarify 快照形态（_clarify_block 单问分支 + request_id）。 */
const CLARIFY_SNAPSHOT = {
  request_id: 'abcd1234',
  question: '要下载 PDF 还是 HTML 版本？',
  choices: ['PDF', 'HTML'],
};

/** 服务端真实的挂起审批快照形态（_approval_request_payload）。 */
const APPROVAL_SNAPSHOT = {
  request_id: 'ap123456',
  command: 'rm -rf output/',
  description: '删除待确认稿',
  choices: ['once', 'session', 'always', 'deny'] as ApprovalChoice[],
};

function mockResume(extra: Record<string, unknown>) {
  mockCall.mockImplementation(async (method: string) => {
    if (method === 'session.resume') {
      return {
        session_id: 'sid1',
        stored_session_id: 'stored1',
        running: false,
        messages: [{role: 'user', text: '开始'}],
        info: {model: 'mock-model'},
        ...extra,
      };
    }
    throw new Error(`unexpected rpc: ${method}`);
  });
}

function items(sid = 'sid1') {
  return useChatStore.getState().bySession[sid]?.items ?? [];
}

function clarifyCards() {
  return items().filter((i): i is ClarifyCardItem => i.kind === 'clarify');
}

function approvalCards() {
  return items().filter((i): i is ApprovalCardItem => i.kind === 'approval');
}

describe('resume 挂起交互恢复（单对象 wire 形态）', () => {
  beforeEach(() => {
    _resetChatAggregators();
    useChatStore.setState({bySession: {}});
    useSessionsStore.setState({byProfile: {}, stale: false, nsMap: null});
    useConnectionStore.setState({state: 'ready'});
    mockCall.mockReset();
  });

  it('pending_clarify 为单对象：打开会话不抛错，澄清卡落地', async () => {
    // 旧实现在这里抛 TypeError（Hermes：「iterator method is not callable」）
    mockResume({pending_clarify: CLARIFY_SNAPSHOT});
    await expect(openSessionFlow('main', row('stored1'))).resolves.toEqual({
      sessionId: 'sid1',
      title: '会话',
    });
    const cards = clarifyCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].requestId).toBe('abcd1234');
    expect(cards[0].questions).toEqual([
      {qid: '', question: '要下载 PDF 还是 HTML 版本？', choices: ['PDF', 'HTML'], multiSelect: false},
    ]);
    expect(cards[0].answeredQids).toEqual([]);
  });

  it('pending_approval 为单对象：审批卡落地', async () => {
    mockResume({pending_approval: APPROVAL_SNAPSHOT});
    await expect(openSessionFlow('main', row('stored1'))).resolves.toBeTruthy();
    const cards = approvalCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].requestId).toBe('ap123456');
    expect(cards[0].choices).toEqual(['once', 'session', 'always', 'deny']);
  });

  it('批量 clarify 快照带 answers：已锁定题目播种为已答', async () => {
    mockResume({
      pending_clarify: {
        request_id: 'batch001',
        questions: [
          {qid: 'q0', question: '选哪个口径？', choices: ['口径A', '口径B'], multi_select: false},
          {qid: 'q1', question: '要几份？', choices: ['1', '2'], multi_select: false},
        ],
        answers: {q0: '口径A'},
      },
    });
    await expect(openSessionFlow('main', row('stored1'))).resolves.toBeTruthy();
    const cards = clarifyCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].questions.map(q => q.qid)).toEqual(['q0', 'q1']);
    // 只播种确实存在的 qid（服务端 answers 键即 qid）
    expect(cards[0].answeredQids).toEqual(['q0']);
  });

  it('两个挂起交互同时返回（单对象）：都能恢复', async () => {
    mockResume({
      pending_approval: APPROVAL_SNAPSHOT,
      pending_clarify: CLARIFY_SNAPSHOT,
    });
    await expect(openSessionFlow('main', row('stored1'))).resolves.toBeTruthy();
    expect(clarifyCards()).toHaveLength(1);
    expect(approvalCards()).toHaveLength(1);
  });

  it('旧版服务端返回数组形态：仍然兼容（不重复、不裂成多卡）', async () => {
    mockResume({
      pending_clarify: [CLARIFY_SNAPSHOT],
      pending_approval: [APPROVAL_SNAPSHOT],
    });
    await expect(openSessionFlow('main', row('stored1'))).resolves.toBeTruthy();
    expect(clarifyCards()).toHaveLength(1);
    expect(approvalCards()).toHaveLength(1);
  });

  it('attach 直传单对象（重连 reattach 路径同款）：不抛错且卡片落地', () => {
    expect(() =>
      useChatStore.getState().attach('sid2', {
        messages: [],
        profile: 'main',
        storedSessionId: 'stored2',
        pendingClarifies: CLARIFY_SNAPSHOT,
        pendingApprovals: APPROVAL_SNAPSHOT,
      }),
    ).not.toThrow();
    const sid2 = items('sid2');
    expect(sid2.filter(i => i.kind === 'clarify')).toHaveLength(1);
    expect(sid2.filter(i => i.kind === 'approval')).toHaveLength(1);
  });

  it('reattachAfterResume 单对象：live sid 迁移后卡片仍恢复', () => {
    useChatStore.getState().attach('oldSid', {
      messages: [],
      profile: 'main',
      storedSessionId: 'stored1',
    });
    expect(() =>
      useChatStore.getState().reattachAfterResume('oldSid', 'newSid', {
        messages: [],
        running: true,
        pendingClarifies: CLARIFY_SNAPSHOT,
      }),
    ).not.toThrow();
    const s = useChatStore.getState().bySession;
    // 旧 key 保留 migratedTo shell（页面跟随），卡片恢复到新 key
    expect(s.oldSid?.migratedTo).toBe('newSid');
    expect(s.newSid.items.filter(i => i.kind === 'clarify')).toHaveLength(1);
  });
});
