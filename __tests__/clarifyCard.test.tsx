/**
 * ClarifyCard 交互（D052）：卡片内只填草稿（单选点选 / 多选勾选 / 自由文本，
 * 选项与文本互斥、后改者生效），卡片底部单一「提交回答」按钮整体提交——
 * 全部未答题有草稿才点亮；已答题显示问题 + 答案文本；历史只读卡显示「已作答」。
 */
import React from 'react';
import {Text, TextInput, TouchableOpacity} from 'react-native';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';

import {ClarifyCard} from '../src/components/ClarifyCard';
import type {ClarifyCardItem} from '../src/rpc/types';

const BATCH_CARD: ClarifyCardItem = {
  kind: 'clarify',
  id: 'cl-1',
  requestId: 'r1',
  questions: [
    {qid: 'q0', question: '选数据集', choices: ['A数据集', 'B数据集']},
    {qid: 'q1', question: '时间范围？', choices: []},
  ],
  answeredQids: [],
};

function render(card: ClarifyCardItem) {
  const onSubmit = jest.fn();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<ClarifyCard card={card} onSubmit={onSubmit} />);
  });
  return {tree, onSubmit};
}

/** 选项 chips 在前、提交按钮在最后 */
function choices(tree: ReactTestRenderer) {
  const btns = tree.root.findAllByType(TouchableOpacity);
  return btns.slice(0, btns.length - 1);
}

function submitBtn(tree: ReactTestRenderer) {
  const btns = tree.root.findAllByType(TouchableOpacity);
  return btns[btns.length - 1];
}

function texts(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(Text)
    .map(n => n.props.children as string)
    .flat();
}

function joined(tree: ReactTestRenderer): string {
  // 混合子节点（{t()}：{answer}）会拆成多个字符串子节点，直接拼接断言
  return texts(tree).join('');
}

describe('ClarifyCard 草稿式整体提交（D052）', () => {
  it('初始提交按钮禁用；缺题草稿提示剩余数', () => {
    const {tree} = render(BATCH_CARD);
    expect(submitBtn(tree).props.disabled).toBe(true);
    expect(joined(tree)).toContain('还有 2 题未作答');
  });

  it('每题有草稿后点亮；载荷按 qid 归位（单选=选项文本、自由文本=原文）', () => {
    const {tree, onSubmit} = render(BATCH_CARD);
    act(() => choices(tree)[0].props.onPress({})); // q0 选 A数据集
    expect(submitBtn(tree).props.disabled).toBe(true); // q1 还没填
    // q1 是纯文本题：输入框是第二个（q0 的输入框在前）
    act(() =>
      tree.root.findAllByType(TextInput)[1].props.onChangeText('最近 30 天'),
    );
    expect(submitBtn(tree).props.disabled).toBe(false);
    act(() => submitBtn(tree).props.onPress({}));
    expect(onSubmit).toHaveBeenCalledWith('r1', [
      {qid: 'q0', answer: 'A数据集'},
      {qid: 'q1', answer: '最近 30 天'},
    ]);
  });

  it('选项与自定义文本互斥：后改者生效', () => {
    const {tree, onSubmit} = render(BATCH_CARD);
    const q0Input = () => tree.root.findAllByType(TextInput)[0];

    act(() => choices(tree)[0].props.onPress({})); // q0 选 A数据集
    // q0 输入自定义文本 → 选项选择被清空（后改者生效）
    act(() => q0Input().props.onChangeText('自定义答案'));
    act(() => choices(tree)[1].props.onPress({})); // q0 改选 B数据集 → 文本清空
    // 再输文本又清选项，最终以文本为准
    act(() => q0Input().props.onChangeText('最终自定义'));
    act(() =>
      tree.root.findAllByType(TextInput)[1].props.onChangeText('最近 7 天'),
    );
    act(() => submitBtn(tree).props.onPress({}));
    expect(onSubmit).toHaveBeenCalledWith('r1', [
      {qid: 'q0', answer: '最终自定义'},
      {qid: 'q1', answer: '最近 7 天'},
    ]);
  });

  it('多选：勾选多题，答案按选项顺序排成 JSON 数组串', () => {
    const card: ClarifyCardItem = {
      ...BATCH_CARD,
      questions: [
        {
          qid: 'q0',
          question: '要哪些',
          choices: ['甲', '乙', '丙'],
          multiSelect: true,
        },
      ],
    };
    const {tree, onSubmit} = render(card);
    act(() => choices(tree)[2].props.onPress({})); // 丙
    act(() => choices(tree)[0].props.onPress({})); // 甲
    act(() => submitBtn(tree).props.onPress({}));
    expect(onSubmit).toHaveBeenCalledWith('r1', [
      {qid: 'q0', answer: '["甲","丙"]'},
    ]);
  });

  it('单选再点同项取消选择', () => {
    const card: ClarifyCardItem = {
      ...BATCH_CARD,
      questions: [{qid: 'q0', question: '选一个', choices: ['A', 'B']}],
    };
    const {tree} = render(card);
    act(() => choices(tree)[0].props.onPress({}));
    expect(submitBtn(tree).props.disabled).toBe(false);
    act(() => choices(tree)[0].props.onPress({}));
    expect(submitBtn(tree).props.disabled).toBe(true);
  });

  it('已答题显示答案文本；全部答完无提交按钮', () => {
    const card: ClarifyCardItem = {
      ...BATCH_CARD,
      answeredQids: ['q0', 'q1'],
      answers: {q0: 'A数据集', q1: '最近 30 天'},
    };
    const {tree, onSubmit} = render(card);
    expect(joined(tree)).toContain('你的回答：A数据集');
    expect(joined(tree)).toContain('你的回答：最近 30 天');
    expect(joined(tree)).not.toContain('提交回答');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('多选答案展示为连接文本；历史只读卡（无答案）显示已作答', () => {
    const card: ClarifyCardItem = {
      ...BATCH_CARD,
      answeredQids: ['q0', 'q1'],
      answers: {q0: '["甲","丙"]', q1: '最近 30 天'},
      fromHistory: true,
    };
    const {tree} = render(card);
    expect(joined(tree)).toContain('你的回答：甲, 丙');
    expect(joined(tree)).toContain('你的回答：最近 30 天');
  });

  it('部分已答（其他端锁定）：只统计未答题；提交载荷只含未答题', () => {
    const card: ClarifyCardItem = {
      ...BATCH_CARD,
      answeredQids: ['q0'],
      answers: {q0: '他端已锁'},
    };
    const {tree, onSubmit} = render(card);
    expect(joined(tree)).toContain('你的回答：他端已锁');
    expect(joined(tree)).toContain('还有 1 题未作答');
    act(() =>
      tree.root.findAllByType(TextInput)[0].props.onChangeText('自定义'),
    );
    expect(submitBtn(tree).props.disabled).toBe(false);
    act(() => submitBtn(tree).props.onPress({}));
    expect(onSubmit).toHaveBeenCalledWith('r1', [
      {qid: 'q1', answer: '自定义'},
    ]);
  });

  it('submitting 期间按钮禁用且选项不可点', () => {
    const {tree} = render({...BATCH_CARD, submitting: true});
    expect(submitBtn(tree).props.disabled).toBe(true);
    expect(choices(tree).every(c => c.props.disabled === true)).toBe(true);
    expect(tree.root.findAllByType(TextInput)[0].props.editable).toBe(false);
  });

  it('过期卡显示超时不显示提交按钮', () => {
    const {tree} = render({...BATCH_CARD, expired: true});
    expect(joined(tree)).toContain('已超时');
    expect(joined(tree)).not.toContain('提交回答');
  });
});
