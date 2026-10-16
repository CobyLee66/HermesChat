/**
 * ChatInputBar 的排队 UI（D064）：
 * - busy 且输入框有内容时，中断按钮**正上方**出现「排队」按钮（纵向堆叠，
 *   移动端窄屏不挤占输入框横向宽度）；
 * - 排队按钮走同一个 onSend（默认发送动作 = 排队）；
 * - 排队条显示「已排队尚未实际发送」的消息内容，逐条可取消；
 * - 空闲态仍是发送按钮（行为不变）。
 */
import React from 'react';
import {ScrollView, StyleSheet, Text, TouchableOpacity} from 'react-native';
import {act, create, type ReactTestInstance, type ReactTestRenderer} from 'react-test-renderer';

import {ChatInputBar} from '../src/panels/ChatInputBar';
import {_resetChatAggregators, useChatStore} from '../src/store/chat';
import {useConnectionStore} from '../src/store/connection';
import {_resetDraftsForTests} from '../src/store/drafts';
import {
  _resetQueuedPromptsForTests,
  useQueuedPromptsStore,
} from '../src/store/queuedPrompts';
import {sessionIdentityFor} from '../src/store/sessionIdentity';

jest.mock('@react-native-documents/picker', () => ({
  pick: jest.fn(),
  keepLocalCopy: jest.fn(),
  types: {images: 'images', allFiles: 'allFiles'},
  errorCodes: {OPERATION_CANCELED: 'cancelled'},
  isErrorWithCode: () => false,
}));
jest.mock('../src/components/VoiceButton', () => ({VoiceButton: () => null}));
jest.mock('../src/utils/useKeyboardHeight', () => ({
  useKeyboardHeight: () => ({height: 0, bottomPad: 0}),
}));

function attachIdle(sid = 's1') {
  useChatStore.getState().attach(sid, {
    messages: [],
    profile: 'main',
    storedSessionId: `stored-${sid}`,
  });
}

/** 排队 key = 会话跨重启身份（profile + 持久化会话 id），与组件内解析同源 */
const KEY = sessionIdentityFor('main', 's1', 'stored-s1');

function setBusy(sid: string, busy: boolean) {
  useChatStore.setState(s => ({
    bySession: {...s.bySession, [sid]: {...s.bySession[sid], busy}},
  }));
}

function touchableByLabel(
  tree: ReactTestRenderer,
  label: string,
): ReactTestInstance {
  const node = tree.root
    .findAllByType(TouchableOpacity)
    .find(n => n.props.accessibilityLabel === label);
  if (!node) {
    throw new Error(`找不到按钮：${label}`);
  }
  return node;
}

function hasText(tree: ReactTestRenderer, text: string): boolean {
  return tree.root.findAllByType(Text).some(n => n.props.children === text);
}

async function renderBar(props: {
  input: string;
  onSend?: () => void;
  onInputChange?: (v: string) => void;
}): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <ChatInputBar
        sessionId="s1"
        profile="main"
        input={props.input}
        onInputChange={props.onInputChange ?? (() => {})}
        onSend={props.onSend ?? (() => {})}
        attachPanelOpen={false}
        onAttachPanelChange={() => {}}
      />,
    );
  });
  mounted.push(tree);
  return tree;
}

/** 已渲染的树：每个用例结束后卸载，避免跨用例的 store 更新触发 act 警告 */
const mounted: ReactTestRenderer[] = [];

beforeEach(() => {
  _resetChatAggregators();
  _resetDraftsForTests();
  _resetQueuedPromptsForTests();
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

describe('busy 状态下的动作按钮列', () => {
  it('有输入：排队按钮在中断按钮正上方（同一纵向列，排队先渲染）', async () => {
    setBusy('s1', true);
    const tree = await renderBar({input: '要排队的内容'});

    const queue = touchableByLabel(tree, '排队');
    const interrupt = touchableByLabel(tree, '中断');
    const column = queue.parent as ReactTestInstance;
    expect(column).toBe(interrupt.parent);
    expect(StyleSheet.flatten(column.props.style).flexDirection).toBe('column');

    // 同一列内渲染顺序 = 视觉上下顺序：排队在上、中断在下
    const inColumn = column.findAllByType(TouchableOpacity);
    expect(inColumn[0]).toBe(queue);
    expect(inColumn[1]).toBe(interrupt);
  });

  it('排队按钮走 onSend（默认发送动作 = 排队）', async () => {
    setBusy('s1', true);
    const onSend = jest.fn();
    const tree = await renderBar({input: '排队', onSend});
    await act(async () => {
      touchableByLabel(tree, '排队').props.onPress();
    });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('无输入：只渲染中断按钮（不出现排队按钮）', async () => {
    setBusy('s1', true);
    const tree = await renderBar({input: '   '});
    expect(
      tree.root
        .findAllByType(TouchableOpacity)
        .some(n => n.props.accessibilityLabel === '排队'),
    ).toBe(false);
    expect(touchableByLabel(tree, '中断')).toBeTruthy();
  });

  it('空闲：仍是发送按钮，无排队/中断按钮', async () => {
    const tree = await renderBar({input: '普通消息'});
    expect(hasText(tree, '发送')).toBe(true);
    expect(hasText(tree, '中断')).toBe(false);
    expect(hasText(tree, '排队')).toBe(false);
  });
});

describe('排队消息条', () => {
  it('显示已排队消息内容与徽标；点 × 逐条取消', async () => {
    useQueuedPromptsStore.getState().enqueue(KEY, '第一条排队');
    useQueuedPromptsStore.getState().enqueue(KEY, '第二条排队');
    const tree = await renderBar({input: ''});

    expect(hasText(tree, '第一条排队')).toBe(true);
    expect(hasText(tree, '第二条排队')).toBe(true);
    expect(
      tree.root.findAllByType(Text).filter(n => n.props.children === '排队中'),
    ).toHaveLength(2);

    const removes = tree.root
      .findAllByType(TouchableOpacity)
      .filter(n => n.props.accessibilityLabel === '取消排队');
    expect(removes).toHaveLength(2);
    await act(async () => {
      removes[0].props.onPress();
    });
    expect(
      (useQueuedPromptsStore.getState().queues[KEY] ?? []).map(it => it.text),
    ).toEqual(['第二条排队']);
    expect(hasText(tree, '第一条排队')).toBe(false);
  });

  it('队列为空时不渲染排队条（不占空间）', async () => {
    const tree = await renderBar({input: ''});
    expect(tree.root.findAllByType(ScrollView)).toHaveLength(0);
  });

  it('queue 变化即时反映（引擎出队后条目消失）', async () => {
    const [entry] = [useQueuedPromptsStore.getState().enqueue(KEY, '待发送')];
    expect(entry).toBe(true);
    const tree = await renderBar({input: ''});
    expect(hasText(tree, '待发送')).toBe(true);

    const id = useQueuedPromptsStore.getState().queues[KEY][0].id;
    await act(async () => {
      useQueuedPromptsStore.getState().removeQueued(id);
    });
    expect(hasText(tree, '待发送')).toBe(false);
  });
});
