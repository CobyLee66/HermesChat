/**
 * clarify 整体提交（submitClarify，D052）：
 * 协议是逐题 `clarify.respond`（批量问题带 question_id、单问不带），
 * 整体提交 = 按题目顺序连发；成功一题标记一题，中途失败停住（已锁定题
 * 不回滚，重试只补发未答题）；submitting 生命周期防重复提交。
 */
import {_resetChatAggregators, useChatStore} from '../src/store/chat';
import {useConnectionStore} from '../src/store/connection';
import type {
  ClarifyCardItem,
  ClarifyRequestPayload,
  OneOrMany,
} from '../src/rpc/types';

const mockCall = jest.fn<Promise<unknown>, [string, Record<string, unknown>?]>();

jest.mock('../src/rpc/runtime', () => ({
  getRpc: () => ({call: mockCall}),
  setRpc: jest.fn(),
  hasRpc: () => true,
}));

/** 批量两题的挂起快照（batch qid q0/q1） */
const BATCH = {
  request_id: 'clb1',
  questions: [
    {qid: 'q0', question: '问题一', choices: ['a', 'b']},
    {qid: 'q1', question: '问题二', choices: ['x', 'y']},
  ],
};

function seedCard(
  payload: OneOrMany<ClarifyRequestPayload> = BATCH,
): ClarifyCardItem {
  useChatStore.getState().attach('sid1', {
    messages: [{role: 'user', text: '开始'}],
    profile: 'main',
    storedSessionId: 'stored1',
    info: {model: 'mock-model'},
    title: '会话',
    pendingClarifies: payload,
  });
  const seeded = useChatStore
    .getState()
    .bySession.sid1?.items.find(
      i => i.kind === 'clarify',
    ) as ClarifyCardItem;
  expect(seeded).toBeDefined();
  return seeded;
}

function card(): ClarifyCardItem {
  return useChatStore
    .getState()
    .bySession.sid1?.items.find(
      i => i.kind === 'clarify',
    ) as ClarifyCardItem;
}

describe('clarify 整体提交（submitClarify）', () => {
  beforeEach(() => {
    _resetChatAggregators();
    useChatStore.setState({bySession: {}});
    useConnectionStore.setState({state: 'ready'});
    mockCall.mockReset();
  });

  it('批量：按题目顺序连发（带 question_id），成功逐题标记并记录答案', async () => {
    const c = seedCard();
    const calls: [string, Record<string, unknown>?][] = [];
    const submittingAtCall: boolean[] = [];
    mockCall.mockImplementation(async (method, params) => {
      calls.push([method, params]);
      submittingAtCall.push(card().submitting === true);
      return {status: 'ok'};
    });
    await useChatStore.getState().submitClarify('sid1', c.requestId, [
      {qid: 'q0', answer: 'a'},
      {qid: 'q1', answer: 'y'},
    ]);
    expect(calls).toEqual([
      ['clarify.respond', {request_id: 'clb1', answer: 'a', question_id: 'q0'}],
      ['clarify.respond', {request_id: 'clb1', answer: 'y', question_id: 'q1'}],
    ]);
    // 发送期间卡片处于 submitting
    expect(submittingAtCall).toEqual([true, true]);
    const after = card();
    expect(after.submitting).toBe(false);
    expect(after.answeredQids).toEqual(['q0', 'q1']);
    expect(after.answers).toEqual({q0: 'a', q1: 'y'});
  });

  it('单问：不带 question_id', async () => {
    const c = seedCard({
      request_id: 'cls1',
      question: '选哪个？',
      choices: ['A', 'B'],
    });
    mockCall.mockResolvedValue({status: 'ok'});
    await useChatStore.getState().submitClarify('sid1', c.requestId, [
      {qid: '', answer: 'B'},
    ]);
    expect(mockCall).toHaveBeenCalledWith('clarify.respond', {
      request_id: 'cls1',
      answer: 'B',
    });
    expect(card().answeredQids).toEqual(['']);
    expect(card().answers).toEqual({'': 'B'});
  });

  it('中途失败：已成功题保留标记，剩余不发，时间线落红条', async () => {
    const c = seedCard();
    mockCall
      .mockResolvedValueOnce({status: 'ok'})
      .mockRejectedValueOnce(new Error('rpc not connected'));
    await useChatStore.getState().submitClarify('sid1', c.requestId, [
      {qid: 'q0', answer: 'a'},
      {qid: 'q1', answer: 'b'},
    ]);
    expect(mockCall).toHaveBeenCalledTimes(2);
    const after = card();
    expect(after.submitting).toBe(false);
    expect(after.answeredQids).toEqual(['q0']);
    expect(after.answers).toEqual({q0: 'a'});
    const errItem = useChatStore
      .getState()
      .bySession.sid1?.items.find(
        i => i.kind === 'system' && i.eventKind === 'error',
      );
    expect(errItem).toBeDefined();
  });

  it('重试只补发未答题（resume 播种/上次成功的不重发）', async () => {
    // q0 已由服务端锁定（resume answers 播种）
    const c = seedCard({...BATCH, answers: {q0: '锁定值'}});
    expect(c.answeredQids).toEqual(['q0']);
    mockCall.mockResolvedValue({status: 'ok'});
    await useChatStore.getState().submitClarify('sid1', c.requestId, [
      {qid: 'q0', answer: '锁定值'},
      {qid: 'q1', answer: 'y'},
    ]);
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(mockCall).toHaveBeenCalledWith('clarify.respond', {
      request_id: 'clb1',
      answer: 'y',
      question_id: 'q1',
    });
    const after = card();
    expect(after.answeredQids).toEqual(['q0', 'q1']);
    // q0 展示文本保持服务端锁定的原值
    expect(after.answers).toEqual({q0: '锁定值', q1: 'y'});
  });

  it('submitting 期间重复提交被忽略；空答案草稿不发', async () => {
    const c = seedCard();
    let release!: () => void;
    mockCall.mockImplementation(
      () =>
        new Promise(resolve => {
          release = () => resolve({status: 'ok'});
        }),
    );
    const first = useChatStore
      .getState()
      .submitClarify('sid1', c.requestId, [{qid: 'q0', answer: 'a'}]);
    await Promise.resolve();
    // 第一次还在发送中：重复调用直接忽略
    await useChatStore
      .getState()
      .submitClarify('sid1', c.requestId, [{qid: 'q0', answer: 'a'}]);
    // 全空草稿不发任何请求
    await useChatStore.getState().submitClarify('sid1', c.requestId, [
      {qid: 'q0', answer: '  '},
    ]);
    release();
    await first;
    expect(mockCall).toHaveBeenCalledTimes(1);
  });

  it('全答完触发封存：续写事件落到卡片下方（store 层贯通）', async () => {
    const c = seedCard();
    mockCall.mockResolvedValue({status: 'ok'});
    await useChatStore.getState().submitClarify('sid1', c.requestId, [
      {qid: 'q0', answer: 'a'},
      {qid: 'q1', answer: 'b'},
    ]);
    const apply = useChatStore.getState().applyEvent;
    apply('sid1', 'message.delta', {text: '续写内容'});
    const items = useChatStore.getState().bySession.sid1?.items ?? [];
    expect(items.map(i => i.kind)).toEqual([
      'user',
      'clarify',
      'assistant',
    ]);
    // 作答后 turn 仍在跑：busy 不闪断，complete 后回落
    apply('sid1', 'message.complete', {text: ''});
    expect(useChatStore.getState().bySession.sid1?.busy).toBe(false);
  });
});
