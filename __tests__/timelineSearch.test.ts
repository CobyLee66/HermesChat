import {searchTimeline} from '../src/utils/timelineSearch';
import type {TimelineItem} from '../src/rpc/types';

function fixtures(): TimelineItem[] {
  return [
    {kind: 'user', id: 'u1', text: '帮我看看清理脚本的输出'},
    {
      kind: 'assistant',
      id: 'a1',
      streaming: false,
      blocks: [
        {type: 'thinking', text: '用户提到清理，需要先看脚本'},
        {type: 'text', text: '好的，我来分析清理脚本'},
      ],
    },
    {kind: 'system', id: 's1', eventKind: 'status', text: '命令回显：/清理'},
    {kind: 'approval', id: 'ap1', requestId: 'r1', choices: []},
    {
      kind: 'assistant',
      id: 'a2',
      streaming: false,
      blocks: [{type: 'tool', tool: {toolId: 't1', name: 'bash', status: 'done'}}],
    },
    {kind: 'user', id: 'u2', text: ''},
    {
      kind: 'assistant',
      id: 'a3',
      streaming: false,
      blocks: [{type: 'error', text: '清理任务超时'}],
    },
  ];
}

describe('timelineSearch 聊天记录查找', () => {
  test('命中用户/助手/系统文本，保持时间正序', () => {
    expect(searchTimeline(fixtures(), '清理')).toEqual([
      'u1',
      'a1',
      's1',
      'a3',
    ]);
  });

  test('大小写不敏感', () => {
    const items: TimelineItem[] = [
      {kind: 'user', id: 'u1', text: 'please run the Deploy Script'},
    ];
    expect(searchTimeline(items, 'deploy')).toEqual(['u1']);
    expect(searchTimeline(items, 'DEPLOY')).toEqual(['u1']);
  });

  test('thinking/reasoning/tool 块不参与匹配（默认可能隐藏，跳过去看不到）', () => {
    // 「脚本」只出现在 a1 的 thinking 块，不应命中
    const items = fixtures().filter(it => it.id !== 'u1');
    expect(searchTimeline(items, '需要先看脚本')).toEqual([]);
    // 工具卡内容不搜
    expect(searchTimeline(fixtures(), 'bash')).toEqual([]);
  });

  test('一条消息多个块命中只记一个 hit；approval/clarify 不搜', () => {
    const items: TimelineItem[] = [
      {
        kind: 'assistant',
        id: 'a1',
        streaming: false,
        blocks: [
          {type: 'text', text: '报告在前半段'},
          {type: 'error', text: '报告生成失败'},
        ],
      },
      {kind: 'approval', id: 'ap1', requestId: 'r1', choices: []},
    ];
    expect(searchTimeline(items, '报告')).toEqual(['a1']);
  });

  test('空/纯空白 query 无命中', () => {
    expect(searchTimeline(fixtures(), '')).toEqual([]);
    expect(searchTimeline(fixtures(), '   ')).toEqual([]);
  });

  test('query 带首尾空白仍可命中（trim 后匹配）', () => {
    expect(searchTimeline(fixtures(), ' 清理 ')).toEqual([
      'u1',
      'a1',
      's1',
      'a3',
    ]);
  });

  test('无命中返回空数组', () => {
    expect(searchTimeline(fixtures(), '不存在的词')).toEqual([]);
  });
});
