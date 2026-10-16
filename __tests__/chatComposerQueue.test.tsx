/**
 * useChatComposer 的发送分流（D064）：AI 输出中（busy）时「默认发送动作」
 * 改为排队——入队 + 清空草稿 + 回底，不发 RPC；空闲时维持原发送路径。
 */
import React from 'react';
import {Text, TouchableOpacity} from 'react-native';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';

import {useChatComposer} from '../src/panels/useChatComposer';
import {_resetChatAggregators, useChatStore} from '../src/store/chat';
import {useConnectionStore} from '../src/store/connection';
import {_resetDraftsForTests, useDraftStore} from '../src/store/drafts';
import {
  _resetQueuedPromptsForTests,
  useQueuedPromptsStore,
} from '../src/store/queuedPrompts';
import {sessionIdentityFor} from '../src/store/sessionIdentity';

const mockCall = jest.fn<Promise<unknown>, [string, Record<string, unknown>?]>();

jest.mock('../src/rpc/runtime', () => ({
  getRpc: () => ({call: mockCall}),
  setRpc: jest.fn(),
  hasRpc: () => true,
}));

function Harness({
  sessionId,
  onOpenModelPicker,
  onAfterSend,
}: {
  sessionId: string;
  onOpenModelPicker: () => void;
  onAfterSend: () => void;
}) {
  const {input, setInput, onSend} = useChatComposer(
    sessionId,
    onOpenModelPicker,
    onAfterSend,
  );
  return (
    <>
      <Text testID="draft">{input}</Text>
      <TouchableOpacity testID="type" onPress={() => setInput('排队内容')}>
        <Text>type</Text>
      </TouchableOpacity>
      <TouchableOpacity testID="send" onPress={onSend}>
        <Text>send</Text>
      </TouchableOpacity>
    </>
  );
}

function attachIdle(sid = 's1') {
  useChatStore.getState().attach(sid, {
    messages: [],
    profile: 'main',
    storedSessionId: `stored-${sid}`,
  });
}

function setBusy(sid: string, busy: boolean) {
  useChatStore.setState(s => ({
    bySession: {...s.bySession, [sid]: {...s.bySession[sid], busy}},
  }));
}

/** 排队 key = 会话跨重启身份（profile + 持久化会话 id） */
const KEY = sessionIdentityFor('main', 's1', 'stored-s1');

const mounted: ReactTestRenderer[] = [];

async function render(props: {
  onOpenModelPicker?: () => void;
  onAfterSend?: () => void;
} = {}): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <Harness
        sessionId="s1"
        onOpenModelPicker={props.onOpenModelPicker ?? (() => {})}
        onAfterSend={props.onAfterSend ?? (() => {})}
      />,
    );
  });
  mounted.push(tree);
  return tree;
}

function press(tree: ReactTestRenderer, testID: string) {
  const node = tree.root.findAll(
    n => typeof n.type !== 'string' && (n.type as {name?: string}) && n.props.testID === testID,
  );
  if (node.length === 0) {
    throw new Error(`找不到节点：${testID}`);
  }
  return node[0].props.onPress as () => void;
}

function typeText(tree: ReactTestRenderer) {
  act(() => {
    press(tree, 'type')();
  });
}

beforeEach(() => {
  _resetChatAggregators();
  _resetDraftsForTests();
  _resetQueuedPromptsForTests();
  mockCall.mockReset().mockResolvedValue({status: 'streaming'});
  useChatStore.setState({bySession: {}});
  useConnectionStore.setState({state: 'ready'});
  attachIdle();
});

afterEach(() => {
  while (mounted.length > 0) {
    const tree = mounted.pop();
    act(() => {
      tree?.unmount();
    });
  }
});

describe('busy 期间发送 = 排队', () => {
  it('入队 + 清空草稿 + 回底，不发任何 RPC', async () => {
    setBusy('s1', true);
    const onAfterSend = jest.fn();
    const tree = await render({onAfterSend});
    typeText(tree);

    await act(async () => {
      press(tree, 'send')();
    });

    expect(
      (useQueuedPromptsStore.getState().queues[KEY] ?? []).map(it => it.text),
    ).toEqual(['排队内容']);
    // 草稿清空（排队条接管显示）；key = 会话跨重启身份
    expect(useDraftStore.getState().drafts[KEY]).toBeUndefined();
    expect(onAfterSend).toHaveBeenCalledTimes(1);
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('busy 但输入为空：什么都不做（不发 RPC、不入队）', async () => {
    setBusy('s1', true);
    const onAfterSend = jest.fn();
    const tree = await render({onAfterSend});
    await act(async () => {
      press(tree, 'send')();
    });
    expect(useQueuedPromptsStore.getState().queues).toEqual({});
    expect(mockCall).not.toHaveBeenCalled();
    expect(onAfterSend).not.toHaveBeenCalled();
  });

  it('排队已达单会话上限：提示、保留输入不清空', async () => {
    setBusy('s1', true);
    for (let i = 0; i < 20; i++) {
      useQueuedPromptsStore.getState().enqueue(KEY, `t${i}`);
    }
    const onAfterSend = jest.fn();
    const tree = await render({onAfterSend});
    typeText(tree);
    await act(async () => {
      press(tree, 'send')();
    });
    expect(useQueuedPromptsStore.getState().queues[KEY]).toHaveLength(20);
    // 草稿按「会话跨重启身份」存（KEY 即该身份），上限拒绝时不得清空
    expect(useDraftStore.getState().drafts[KEY]).toBe('排队内容');
    expect(onAfterSend).not.toHaveBeenCalled();
  });

  it('裸 /model 仍开模型面板（不排队、不发 RPC）', async () => {
    setBusy('s1', true);
    const onOpenModelPicker = jest.fn();
    const tree = await render({onOpenModelPicker});
    act(() => {
      press(tree, 'type')();
    });
    // 换成 /model（草稿 key = 会话跨重启身份）
    act(() => {
      useDraftStore.getState().setDraft(KEY, '/model');
    });
    await act(async () => {
      press(tree, 'send')();
    });
    expect(onOpenModelPicker).toHaveBeenCalledTimes(1);
    expect(useQueuedPromptsStore.getState().queues).toEqual({});
    expect(mockCall).not.toHaveBeenCalled();
  });
});

describe('空闲时发送 = 原路径', () => {
  it('直接提交 prompt.submit（不带 queued），不入队', async () => {
    const onAfterSend = jest.fn();
    const tree = await render({onAfterSend});
    typeText(tree);
    await act(async () => {
      press(tree, 'send')();
    });

    expect(mockCall).toHaveBeenCalledWith('prompt.submit', {
      session_id: 's1',
      text: '排队内容',
    });
    expect(useQueuedPromptsStore.getState().queues).toEqual({});
    expect(useDraftStore.getState().drafts[KEY]).toBeUndefined();
    expect(onAfterSend).toHaveBeenCalledTimes(1);
  });
});
