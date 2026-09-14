/**
 * 卡片展开按压契约单测（web 分支 + 原生分支对照）。
 * 背景：RNW 的 TouchableOpacity.onPress 走 DOM click（mousedown/up 须落在同一
 * 元素），流式钉底期间内容增长顶走卡片 → click 永不触发、卡片结构性点不开。
 * 修复：web 端展开切换走 onPressIn（mousedown 落点瞬间），onPress 仅放行
 * 键盘/程序化 click（UIEvent.detail=0，鼠标 click ≥1）防双触发；原生维持
 * onPress（responder touchdown 锁定目标，release 无条件触发）。
 *
 * Platform.OS 直接改写（不用 jest.mock：requireActual('react-native') 会绕过
 * RN jest preset 的 haste mock 加载完整原生索引而崩）；expandToggleProps 与
 * 组件渲染都在调用期读 OS，beforeEach 置 web 即覆盖全部断言路径。
 */

import React from 'react';
import {Platform, TouchableOpacity} from 'react-native';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';

import {ThinkingBlock} from '../src/components/ThinkingBlock';
import {ToolCallCard} from '../src/components/ToolCallCard';
import {expandToggleProps} from '../src/utils/expandPress';

const realOS = Platform.OS;
beforeEach(() => {
  (Platform as unknown as {OS: string}).OS = 'web';
});
afterAll(() => {
  (Platform as unknown as {OS: string}).OS = realOS;
});

/** 树中唯一的折叠头 TouchableOpacity（expandToggleProps 的按压 props 挂在它身上；
 *  不能用 props 探测：内部 TouchableWithoutFeedback 也带同名 handler） */
function headerOf(tree: ReactTestRenderer) {
  const nodes = tree.root.findAllByType(TouchableOpacity);
  if (nodes.length !== 1) {
    throw new Error(`折叠头 touchable 数量异常：${nodes.length}`);
  }
  return nodes[0];
}

function textOf(tree: ReactTestRenderer): string {
  return JSON.stringify(tree.toJSON());
}

const MID = 'REASONING_MID_MARK';
const TOOL_MARK = 'TOOL_RESULT_MARK';

describe('expandToggleProps', () => {
  it('web 分支：onPressIn 切换；鼠标 click（detail≥1）不重复触发；键盘/程序化 click（detail=0）触发', () => {
    let n = 0;
    const props = expandToggleProps(() => {
      n += 1;
    });
    expect(typeof props.onPressIn).toBe('function');
    expect(typeof props.onPress).toBe('function');
    props.onPressIn?.({} as never);
    expect(n).toBe(1);
    props.onPress?.({nativeEvent: {detail: 1}} as never);
    expect(n).toBe(1);
    props.onPress?.({nativeEvent: {detail: 0}} as never);
    expect(n).toBe(2);
  });

  it('原生分支：仅 onPress（responder release 触发，按压期间内容移动不影响）', () => {
    (Platform as unknown as {OS: string}).OS = 'android';
    let n = 0;
    const props = expandToggleProps(() => {
      n += 1;
    });
    expect(props.onPressIn).toBeUndefined();
    expect(typeof props.onPress).toBe('function');
    props.onPress?.({} as never);
    expect(n).toBe(1);
  });
});

describe('ThinkingBlock（web 按压 wiring）', () => {
  it('onPressIn 展开/收起；鼠标 click 不双触发；键盘 click 可切换', () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <ThinkingBlock text={`首行\n中部 ${MID}\n尾行`} variant="reasoning" />,
      );
    });
    const header = headerOf(tree);
    expect(textOf(tree)).not.toContain(MID);
    // mousedown 落点瞬间展开（流式卡片移动不再影响）
    act(() => header.props.onPressIn({}));
    expect(textOf(tree)).toContain(MID);
    // 随后的鼠标 click（detail≥1）被吞，不双触发
    act(() => header.props.onPress({nativeEvent: {detail: 1}}));
    expect(textOf(tree)).toContain(MID);
    // 键盘 click（detail=0）收起
    act(() => header.props.onPress({nativeEvent: {detail: 0}}));
    expect(textOf(tree)).not.toContain(MID);
  });
});

describe('ToolCallCard（web 按压 wiring）', () => {
  it('onPressIn 展开结果；鼠标 click 不双触发', () => {
    const tool = {
      toolId: 't1',
      name: 'read_file',
      args: {path: '/tmp/x.txt'},
      status: 'done' as const,
      result: `文件内容\n${TOOL_MARK}`,
    };
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<ToolCallCard tool={tool} />);
    });
    const header = headerOf(tree);
    expect(textOf(tree)).not.toContain(TOOL_MARK);
    act(() => header.props.onPressIn({}));
    expect(textOf(tree)).toContain(TOOL_MARK);
    act(() => header.props.onPress({nativeEvent: {detail: 1}}));
    expect(textOf(tree)).toContain(TOOL_MARK);
  });
});
