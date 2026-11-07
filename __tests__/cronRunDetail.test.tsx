/**
 * CronRunDetailPanel：
 * - isCronOutputRun：no_agent（脚本）任务运行识别（source 声明 + id 前缀兜底）
 * - 脚本任务运行详情：不发起 messages 请求（cron_output: id 不是会话 id，
 *   打过去必 404），直接渲染 runs 行元信息 + 摘要 + 说明灰条，无「在聊天中打开」
 * - 会话型运行详情：messages 端点照常调用、回放渲染（回归守卫）
 *
 * jest.mock 工厂必须自包含（babel-jest-hoist 禁止引用外层变量），mock 实例
 * 挂在被 mock 模块的 __mocks 上取回（cronStore.test.ts 同款约定）。
 */

import React from 'react';
import {ScrollView, Text} from 'react-native';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';

import {useConnectionStore} from '../src/store/connection';
import {isCronOutputRun} from '../src/rpc/cron';
import type {CronRunRow} from '../src/rpc/types';
import {CronRunDetailPanel} from '../src/panels/CronRunDetailPanel';

jest.mock('../src/rpc/restSessions', () => {
  const actual = jest.requireActual<typeof import('../src/rpc/restSessions')>(
    '../src/rpc/restSessions',
  );
  const get = jest.fn();
  return {getSessionMessages: get, projectRunMessages: actual.projectRunMessages, __mocks: {get}};
});

// Bubble → MarkdownText → react-native-markdown-display 是未编译 JSX，jest
// preset 不转 node_modules（expandCards.web.test.tsx 同款坑）：具名导出打桩
jest.mock('../src/components/MarkdownText', () => {
  const R = require('react');
  const {Text: RNText} = require('react-native');
  return {
    MarkdownText: ({text}: {text: string}) =>
      R.createElement(RNText, null, text),
  };
});

const restApi = jest.requireMock('../src/rpc/restSessions') as {
  __mocks: {get: jest.Mock};
};
const {get: getSessionMessages} = restApi.__mocks;

function sessionRun(over: Partial<CronRunRow> = {}): CronRunRow {
  return {
    id: 'cron-run-1',
    title: '每日站会摘要 · 09-10',
    preview: '今日站会要点已生成',
    started_at: 1760000000,
    last_active: 1760000060,
    message_count: 2,
    is_active: false,
    archived: false,
    profile: 'mock',
    source: 'cron',
    ...over,
  };
}

function scriptRun(over: Partial<CronRunRow> = {}): CronRunRow {
  return sessionRun({
    id: 'cron_output:cronjob-smoke-0001:2026-11-07_02-00-10',
    title: 'FAILED · exit code 1',
    preview: '⚠ Cron watchdog script failed: guard rail tripped',
    message_count: 0,
    source: 'cron_output',
    ...over,
  });
}

function render(run: CronRunRow, jobName?: string): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<CronRunDetailPanel run={run} jobName={jobName} />);
  });
  return tree;
}

function joined(tree: ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(n => n.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join('');
}

describe('isCronOutputRun', () => {
  it('source=cron_output 命中', () => {
    expect(isCronOutputRun({id: '任意', source: 'cron_output'})).toBe(true);
  });

  it('source 缺失时以 cron_output: id 前缀兜底', () => {
    expect(
      isCronOutputRun({id: 'cron_output:job1:2026-11-07_02-00-10'}),
    ).toBe(true);
  });

  it('会话型运行（source=cron、无前缀）不命中', () => {
    expect(isCronOutputRun({id: 'cron-run-1', source: 'cron'})).toBe(false);
    expect(isCronOutputRun({id: 'cron-run-1'})).toBe(false);
  });
});

describe('CronRunDetailPanel 脚本任务运行', () => {
  beforeEach(() => {
    getSessionMessages.mockClear();
    useConnectionStore.setState({httpUrl: 'http://test', token: 'tok'});
  });

  it('不发起 messages 请求，渲染元信息/摘要/说明灰条，无「在聊天中打开」', () => {
    const tree = render(scriptRun(), '每日站会摘要');
    const text = joined(tree);
    expect(getSessionMessages).not.toHaveBeenCalled();
    expect(text).toContain('每日站会摘要');
    expect(text).toContain('已结束');
    expect(text).toContain('⚠ Cron watchdog script failed: guard rail tripped');
    expect(text).toContain('脚本任务不产生会话记录');
    expect(text).not.toContain('在聊天中打开');
  });

  it('无摘要时落占位文案', () => {
    const tree = render(scriptRun({preview: undefined}));
    expect(joined(tree)).toContain('该次运行没有留下摘要');
  });

  it('脚本分支渲染在 ScrollView 内（内容超出容器可滚动看全）', () => {
    const tree = render(scriptRun());
    expect(tree.root.findByType(ScrollView)).toBeTruthy();
  });

  it('jobName 缺省回退 run.title', () => {
    const tree = render(scriptRun());
    expect(joined(tree)).toContain('FAILED · exit code 1');
  });
});

describe('CronRunDetailPanel 会话型运行（回归守卫）', () => {
  beforeEach(() => {
    getSessionMessages.mockClear();
    useConnectionStore.setState({httpUrl: 'http://test', token: 'tok'});
  });

  it('照常调用 messages 端点并渲染回放（tool/hidden 行过滤不变）', async () => {
    getSessionMessages.mockResolvedValue({
      session_id: 'cron-run-1',
      messages: [
        {role: 'user', content: '整理今天的站会要点并生成摘要', timestamp: 1760000000},
        {role: 'tool', content: '{"cmd":"cat"}', name: 'bash', timestamp: 1760000010},
        {role: 'assistant', content: '要点已生成', timestamp: 1760000020},
      ],
      pagination: {limit: 500, offset: 0, order: 'latest', returned: 3},
    });
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<CronRunDetailPanel run={sessionRun()} />);
    });
    expect(getSessionMessages).toHaveBeenCalledTimes(1);
    expect(getSessionMessages).toHaveBeenCalledWith(
      'http://test',
      'tok',
      'cron-run-1',
      'mock',
    );
    const text = joined(tree);
    expect(text).toContain('整理今天的站会要点并生成摘要');
    expect(text).toContain('要点已生成');
    expect(text).not.toContain('"cmd":"cat"');
  });
});
