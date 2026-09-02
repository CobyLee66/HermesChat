import {TimelineAggregator} from '../src/rpc/aggregator';
import type {
  ApprovalCardItem,
  AssistantMsg,
  ClarifyCardItem,
  SystemEvent,
  ToolCallBlock,
  UserMsg,
} from '../src/rpc/types';

function assistantItems(agg: TimelineAggregator): AssistantMsg[] {
  return agg.getItems().filter(i => i.kind === 'assistant') as AssistantMsg[];
}

function lastAssistant(agg: TimelineAggregator): AssistantMsg {
  const list = assistantItems(agg);
  return list[list.length - 1];
}

describe('TimelineAggregator 消息流', () => {
  it('message.start → delta → complete 聚合成一条助手消息', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('message.start', {});
    agg.applyEvent('message.delta', {text: '你'});
    agg.applyEvent('message.delta', {text: '好'});
    agg.applyEvent('message.complete', {text: '你好', usage: {}});
    const items = agg.getItems();
    expect(items).toHaveLength(1);
    const msg = items[0] as AssistantMsg;
    expect(msg.kind).toBe('assistant');
    expect(msg.streaming).toBe(false);
    expect(msg.blocks).toEqual([{type: 'text', text: '你好'}]);
  });

  it('流式中 streaming=true，complete 后变 false', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('message.start', {});
    expect(agg.isStreaming()).toBe(true);
    agg.applyEvent('message.delta', {text: 'pong'});
    expect(lastAssistant(agg).streaming).toBe(true);
    agg.applyEvent('message.complete', {text: 'pong', status: 'complete'});
    expect(agg.isStreaming()).toBe(false);
  });

  it('思考块：thinking.delta 聚合成折叠块', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('message.start', {});
    agg.applyEvent('thinking.delta', {text: '想一'});
    agg.applyEvent('thinking.delta', {text: '想二'});
    agg.applyEvent('message.delta', {text: '答'});
    agg.applyEvent('message.complete', {text: '答'});
    const msg = lastAssistant(agg);
    expect(msg.blocks[0]).toEqual({type: 'thinking', text: '想一想二'});
    expect(msg.blocks[1]).toEqual({type: 'text', text: '答'});
  });

  it('reasoning.delta 与 thinking.delta 分开成块', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('message.start', {});
    agg.applyEvent('reasoning.delta', {text: 'R1'});
    agg.applyEvent('thinking.delta', {text: 'T1'});
    agg.applyEvent('message.complete', {text: ''});
    const msg = lastAssistant(agg);
    expect(msg.blocks[0].type).toBe('reasoning');
    expect(msg.blocks[1].type).toBe('thinking');
  });

  it('message.interim(already_streamed) 后 delta 开新 text 块', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('message.start', {});
    agg.applyEvent('message.delta', {text: '第一段'});
    agg.applyEvent('message.interim', {text: '第一段', already_streamed: true});
    agg.applyEvent('message.delta', {text: '第二段'});
    agg.applyEvent('message.complete', {text: ''});
    const msg = lastAssistant(agg);
    const texts = msg.blocks.filter(b => b.type === 'text');
    expect(texts).toEqual([
      {type: 'text', text: '第一段'},
      {type: 'text', text: '第二段'},
    ]);
  });

  it('message.interim(非 already_streamed) 追加独立文本块', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('message.start', {});
    agg.applyEvent('message.interim', {text: '中间说明', already_streamed: false});
    agg.applyEvent('message.delta', {text: '正文'});
    agg.applyEvent('message.complete', {text: '正文'});
    const msg = lastAssistant(agg);
    const texts = msg.blocks.filter(b => b.type === 'text').map(b => b.text);
    expect(texts).toEqual(['中间说明', '正文']);
  });
});

describe('TimelineAggregator 工具卡片', () => {
  it('tool.start/complete 按 tool_id 合并', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('message.start', {});
    agg.applyEvent('tool.start', {
      tool_id: 't1',
      name: 'exec',
      context: 'ls -la',
      args: {command: 'ls -la'},
    });
    let msg = lastAssistant(agg);
    let toolBlock = msg.blocks[0] as {type: 'tool'; tool: ToolCallBlock};
    expect(toolBlock.tool.status).toBe('running');

    agg.applyEvent('tool.complete', {
      tool_id: 't1',
      name: 'exec',
      args: {command: 'ls -la'},
      result: 'ok',
      duration_s: 1.5,
    });
    msg = lastAssistant(agg);
    expect(msg.blocks).toHaveLength(1);
    toolBlock = msg.blocks[0] as {type: 'tool'; tool: ToolCallBlock};
    expect(toolBlock.tool.status).toBe('done');
    expect(toolBlock.tool.result).toBe('ok');
    expect(toolBlock.tool.durationS).toBe(1.5);
  });

  it('tool.complete 没有对应 start 时补卡片（中途接入）', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('tool.complete', {
      tool_id: 't9',
      name: 'read_file',
      result: {content: 'x'},
    });
    const msg = lastAssistant(agg);
    const b = msg.blocks[0] as {type: 'tool'; tool: ToolCallBlock};
    expect(b.tool.name).toBe('read_file');
    expect(b.tool.status).toBe('done');
  });

  it('tool.progress 更新进度文本', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('tool.start', {tool_id: 't2', name: 'exec'});
    agg.applyEvent('tool.progress', {tool_id: 't2', preview: '运行中 50%'});
    const msg = lastAssistant(agg);
    const b = msg.blocks[0] as {type: 'tool'; tool: ToolCallBlock};
    expect(b.tool.progress).toBe('运行中 50%');
    expect(b.tool.status).toBe('running');
  });
});

describe('TimelineAggregator 审批卡生命周期', () => {
  it('approval.request 生成卡片 → resolveApproval 标记已处理', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('approval.request', {
      request_id: 'r1',
      command: 'rm -rf /tmp/x',
      description: '删除目录',
      choices: ['once', 'session', 'always', 'deny'],
    });
    let card = agg.getItems()[0] as ApprovalCardItem;
    expect(card.kind).toBe('approval');
    expect(card.requestId).toBe('r1');
    expect(card.resolved).toBeUndefined();
    expect(card.choices).toContain('deny');

    agg.resolveApproval('r1', 'once');
    card = agg.getItems()[0] as ApprovalCardItem;
    expect(card.resolved).toBe('once');
  });

  it('同 request_id 重复 approval.request 去重', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('approval.request', {request_id: 'r1', command: 'a'});
    agg.applyEvent('approval.request', {request_id: 'r1', command: 'a'});
    const cards = agg.getItems().filter(i => i.kind === 'approval');
    expect(cards).toHaveLength(1);
  });

  it('缺 choices 时给默认四选项', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('approval.request', {request_id: 'r2'});
    const card = agg.getItems()[0] as ApprovalCardItem;
    expect(card.choices).toEqual(['once', 'session', 'always', 'deny']);
  });

  it('approval.expire 标记卡片已超时', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('approval.request', {request_id: 'r1', command: 'a'});
    agg.applyEvent('approval.expire', {request_id: 'r1'});
    const card = agg.getItems()[0] as ApprovalCardItem;
    expect(card.expired).toBe(true);
  });
});

describe('TimelineAggregator 澄清提问卡', () => {
  it('clarify.request 单问生成卡片，resolveClarify 标记已答', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('clarify.request', {
      request_id: 'c1',
      question: '选哪个方案？',
      choices: ['A', 'B'],
    });
    let card = agg.getItems()[0] as ClarifyCardItem;
    expect(card.kind).toBe('clarify');
    expect(card.questions).toEqual([
      {qid: '', question: '选哪个方案？', choices: ['A', 'B'], multiSelect: false},
    ]);
    expect(card.answeredQids).toEqual([]);

    agg.resolveClarify('c1', '');
    card = agg.getItems()[0] as ClarifyCardItem;
    expect(card.answeredQids).toEqual(['']);
  });

  it('clarify.request 批量问题带 qid，逐题标记', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('clarify.request', {
      request_id: 'c2',
      questions: [
        {qid: 'q0', question: '问题一', choices: ['x']},
        {qid: 'q1', question: '问题二', choices: ['y', 'z'], multi_select: true},
      ],
    });
    const card = agg.getItems()[0] as ClarifyCardItem;
    expect(card.questions).toHaveLength(2);
    expect(card.questions[1].multiSelect).toBe(true);

    agg.resolveClarify('c2', 'q0');
    const after = agg.getItems()[0] as ClarifyCardItem;
    expect(after.answeredQids).toEqual(['q0']);
  });

  it('同 request_id 重复 clarify.request 去重；clarify.expire 标记超时', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('clarify.request', {request_id: 'c3', question: '问'});
    agg.applyEvent('clarify.request', {request_id: 'c3', question: '问'});
    expect(agg.getItems().filter(i => i.kind === 'clarify')).toHaveLength(1);
    agg.applyEvent('clarify.expire', {request_id: 'c3'});
    expect((agg.getItems()[0] as ClarifyCardItem).expired).toBe(true);
  });
});

describe('TimelineAggregator 错误与状态', () => {
  it('error 事件（非流式）生成红色系统条', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('error', {message: 'boom'});
    const item = agg.getItems()[0] as SystemEvent;
    expect(item.kind).toBe('system');
    expect(item.eventKind).toBe('error');
    expect(item.text).toBe('boom');
  });

  it('error 事件（流式中）挂到当前消息并结束流式', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('message.start', {});
    agg.applyEvent('message.delta', {text: '半截'});
    agg.applyEvent('error', {message: 'provider 500'});
    const msg = lastAssistant(agg);
    expect(msg.streaming).toBe(false);
    expect(msg.blocks.some(b => b.type === 'error')).toBe(true);
  });

  it('message.complete status=error 生成错误块', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('message.start', {});
    agg.applyEvent('message.complete', {
      text: '',
      status: 'error',
      error: '模型限流',
    });
    const msg = lastAssistant(agg);
    expect(msg.blocks).toEqual([{type: 'error', text: '模型限流'}]);
  });

  it('status.update 更新 lastStatus 但不进时间线', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('status.update', {kind: 'compacting', text: '正在压缩上下文'});
    expect(agg.lastStatus).toEqual({kind: 'compacting', text: '正在压缩上下文'});
    expect(agg.getItems()).toHaveLength(0);
  });
});

describe('TimelineAggregator 历史投影', () => {
  it('hydrate：user/assistant/tool 行投影成时间线', () => {
    const agg = new TimelineAggregator();
    agg.hydrate([
      {role: 'user', text: '你好', timestamp: 1000},
      {role: 'assistant', text: '你好！', timestamp: 1001},
      {role: 'tool', name: 'exec', context: 'ls', args: {command: 'ls'}},
      {role: 'assistant', text: '', reasoning: '想了一下', timestamp: 1002},
      {role: 'user', text: '[System: internal]', display_kind: 'hidden'},
    ]);
    const items = agg.getItems();
    expect(items).toHaveLength(4);
    expect((items[0] as UserMsg).kind).toBe('user');
    expect((items[1] as AssistantMsg).blocks[0]).toEqual({
      type: 'text',
      text: '你好！',
    });
    // 工具行
    const toolMsg = items[2] as AssistantMsg;
    expect(toolMsg.blocks[0].type).toBe('tool');
    // 空文本但有 reasoning 的 assistant 保留为思考块
    const reasonMsg = items[3] as AssistantMsg;
    expect(reasonMsg.blocks[0]).toEqual({type: 'thinking', text: '想了一下'});
  });

  it('hydrate 后接 live 事件互不影响', () => {
    const agg = new TimelineAggregator();
    agg.hydrate([{role: 'user', text: '旧消息'}]);
    agg.applyEvent('message.start', {});
    agg.applyEvent('message.delta', {text: '新回复'});
    agg.applyEvent('message.complete', {text: '新回复'});
    expect(agg.getItems()).toHaveLength(2);
    expect(agg.isStreaming()).toBe(false);
  });
});

describe('TimelineAggregator 本地回显', () => {
  it('appendUserMessage 追加用户气泡', () => {
    const agg = new TimelineAggregator();
    agg.appendUserMessage('测试');
    const item = agg.getItems()[0] as UserMsg;
    expect(item.kind).toBe('user');
    expect(item.text).toBe('测试');
  });
});

describe('TimelineAggregator 图片/文件引用解析', () => {
  const DATA_URL = `data:image/png;base64,${'A'.repeat(80)}`;

  it('hydrate：user 文本里的 @image: 指令行剥离成 images', () => {
    const agg = new TimelineAggregator();
    agg.hydrate([
      {
        role: 'user',
        text: '看看这张\n@image:/home/u/images/upload_1.png\n@image:`/tmp/with space/2.jpg`',
      },
    ]);
    const msg = agg.getItems()[0] as UserMsg;
    expect(msg.kind).toBe('user');
    expect(msg.text).toBe('看看这张');
    expect(msg.images).toEqual([
      {path: '/home/u/images/upload_1.png'},
      {path: '/tmp/with space/2.jpg'},
    ]);
  });

  it('hydrate：纯图片消息（无文本）也保留', () => {
    const agg = new TimelineAggregator();
    agg.hydrate([{role: 'user', text: '@image:/p/1.png'}]);
    const msg = agg.getItems()[0] as UserMsg;
    expect(msg.text).toBe('');
    expect(msg.images).toEqual([{path: '/p/1.png'}]);
  });

  it('hydrate：image_url content part 拍平成的 data URL 行还原成图片', () => {
    const agg = new TimelineAggregator();
    // 服务端 _coerce_message_text 把 image parts 的 url 以独立行追加进 text
    agg.hydrate([{role: 'user', text: `拍的图\n${DATA_URL}`}]);
    const msg = agg.getItems()[0] as UserMsg;
    expect(msg.text).toBe('拍的图');
    expect(msg.images).toEqual([{uri: DATA_URL}]);
  });

  it('hydrate：assistant 文本里的 @image:/@file: 拆成独立块', () => {
    const agg = new TimelineAggregator();
    agg.hydrate([
      {
        role: 'assistant',
        text: '截图好了\n@image:/tmp/shot.png\n@file:attachments/报告.pdf',
      },
    ]);
    const msg = agg.getItems()[0] as AssistantMsg;
    expect(msg.blocks).toEqual([
      {type: 'text', text: '截图好了'},
      {type: 'image', image: {path: '/tmp/shot.png'}},
      {
        type: 'file',
        file: {ref: 'attachments/报告.pdf', name: '报告.pdf'},
      },
    ]);
  });

  it('live：message.complete 时把流式文本里的 @image: 拆成图片块', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('message.start', {});
    agg.applyEvent('message.delta', {text: '图在这'});
    agg.applyEvent('message.delta', {text: '\n@image:/tmp/a.png'});
    agg.applyEvent('message.complete', {text: '图在这\n@image:/tmp/a.png'});
    const msg = lastAssistant(agg);
    expect(msg.blocks).toEqual([
      {type: 'text', text: '图在这'},
      {type: 'image', image: {path: '/tmp/a.png'}},
    ]);
  });

  it('live：无引用的文本 complete 后保持单 text 块（不引入多余拆分）', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('message.start', {});
    agg.applyEvent('message.delta', {text: '普通回复'});
    agg.applyEvent('message.complete', {text: '普通回复'});
    const msg = lastAssistant(agg);
    expect(msg.blocks).toEqual([{type: 'text', text: '普通回复'}]);
  });

  it('appendUserMessage 带待发图片 + 文本里的 @file: 引用', () => {
    const agg = new TimelineAggregator();
    const msg = agg.appendUserMessage('分析 @file:attachments/a.pdf', [
      {path: '/p/1.jpg'},
    ]);
    expect(msg.text).toBe('分析');
    expect(msg.images).toEqual([{path: '/p/1.jpg'}]);
    expect(msg.files).toEqual([{ref: 'attachments/a.pdf', name: 'a.pdf'}]);
  });
});
