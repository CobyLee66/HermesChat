/**
 * 输入框草稿的 key 口径（2026-10-17 修订 D060）：按「会话跨重启身份」存
 * （`sessionIdentityFor(profile, liveSid, storedId)`），不再是 live sid。
 *
 * 背景：live sid 在 WS 断开超宽限被孤儿回收/闲置 TTL/网关重启后会换，用 live
 * sid 当 key 时「App 退出 → 重进会话」读的是另一个 key，草稿等于丢了（原复验
 * 路径③只在 resume 恰好复用同一 live sid 时成立）。本文件把「换 live sid 不丢
 * 草稿」「会话重建才搬 key」两条钉住。
 */
import React from 'react';
import {Text, TouchableOpacity} from 'react-native';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';

import {useChatComposer} from '../src/panels/useChatComposer';
import {RpcError} from '../src/rpc/client';
import {_resetChatAggregators, useChatStore} from '../src/store/chat';
import {useConnectionStore} from '../src/store/connection';
import {_resetDraftsForTests, useDraftStore} from '../src/store/drafts';
import {_resetQueuedPromptsForTests} from '../src/store/queuedPrompts';
import {sessionIdentityFor} from '../src/store/sessionIdentity';

const mockCall = jest.fn<Promise<unknown>, [string, Record<string, unknown>?]>();

jest.mock('../src/rpc/runtime', () => ({
  getRpc: () => ({call: mockCall}),
  setRpc: jest.fn(),
  hasRpc: () => true,
}));

function Harness({sessionId}: {sessionId: string}) {
  const {input, setInput} = useChatComposer(sessionId, () => {});
  return (
    <>
      <Text testID="draft">{input}</Text>
      <TouchableOpacity testID="type" onPress={() => setInput('写到一半的话')}>
        <Text>type</Text>
      </TouchableOpacity>
    </>
  );
}

function attach(sid: string, storedId: string) {
  useChatStore.getState().attach(sid, {
    messages: [],
    profile: 'main',
    storedSessionId: storedId,
  });
}

const mounted: ReactTestRenderer[] = [];

async function render(sessionId: string): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<Harness sessionId={sessionId} />);
  });
  mounted.push(tree);
  return tree;
}

function node(tree: ReactTestRenderer, testID: string) {
  const hit = tree.root.findAll(n => n.props?.testID === testID);
  if (hit.length === 0) {
    throw new Error(`找不到节点：${testID}`);
  }
  return hit[0];
}

beforeEach(() => {
  _resetChatAggregators();
  _resetDraftsForTests();
  _resetQueuedPromptsForTests();
  mockCall.mockReset().mockResolvedValue({status: 'streaming'});
  useChatStore.setState({bySession: {}});
  useConnectionStore.setState({state: 'ready'});
});

afterEach(() => {
  while (mounted.length > 0) {
    const tree = mounted.pop();
    act(() => {
      tree?.unmount();
    });
  }
});

describe('草稿 key = 会话跨重启身份', () => {
  it('输入写入身份 key（不写 live sid）', async () => {
    attach('live1', 'stored-1');
    const tree = await render('live1');
    await act(async () => {
      node(tree, 'type').props.onPress();
    });
    const {drafts} = useDraftStore.getState();
    expect(drafts[sessionIdentityFor('main', 'live1', 'stored-1')]).toBe(
      '写到一半的话',
    );
    expect(drafts).not.toHaveProperty('live1');
  });

  it('App 退出重进换了 live sid：同一身份读回旧草稿', async () => {
    attach('liveOLD', 'stored-1');
    const tree = await render('liveOLD');
    await act(async () => {
      node(tree, 'type').props.onPress();
    });

    // 进程被杀 → 重启：会话状态清空，然后 resume 拿到**新的** live sid
    await act(async () => {
      useChatStore.setState({bySession: {}});
      tree.update(<Harness sessionId="liveNEW" />);
      attach('liveNEW', 'stored-1');
    });
    expect(node(tree, 'draft').props.children).toBe('写到一半的话');
  });

  it('会话重建（自愈新建库行）：持久身份变了，chat store 把草稿搬到新 key', async () => {
    attach('live1', 'stored-old');
    useDraftStore
      .getState()
      .setDraft(sessionIdentityFor('main', 'live1', 'stored-old'), '重建也要留');
    // live sid 失效 + 空会话（resume 必 4007）→ 走 session.create 重建
    useChatStore.getState().markStaleLive('live1');
    useChatStore.setState(s => ({
      bySession: {
        ...s.bySession,
        live1: {...s.bySession.live1, pendingFirstSubmit: true},
      },
    }));
    mockCall.mockImplementation((method: string) => {
      if (method === 'session.resume') {
        // 自愈分支只认 RpcError(4007)（服务端「会话不存在」）
        return Promise.reject(new RpcError(4007, 'session not found'));
      }
      if (method === 'session.create') {
        return Promise.resolve({
          session_id: 'live2',
          stored_session_id: 'stored-new',
          messages: [],
        });
      }
      if (method === 'session.usage') {
        return Promise.resolve({});
      }
      return Promise.resolve({status: 'streaming'});
    });

    await act(async () => {
      await useChatStore.getState().sendPrompt('live1', '重建后发送');
    });

    const {drafts} = useDraftStore.getState();
    expect(drafts[sessionIdentityFor('main', 'live2', 'stored-new')]).toBe(
      '重建也要留',
    );
    expect(drafts).not.toHaveProperty(
      sessionIdentityFor('main', 'live1', 'stored-old'),
    );
  });
});
