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

  it('thinking.delta 是 busy 占位提示：非空覆盖、空串清除、不进正文', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('message.start', {});
    agg.applyEvent('thinking.delta', {text: '(´･_･`) processing...'});
    expect(agg.lastThinkingHint).toBe('(´･_･`) processing...');
    // 下一次 API 调用的占位覆盖上一条（服务端 spinner 改写语义）
    agg.applyEvent('thinking.delta', {text: '(¬‿¬) ruminating...'});
    expect(agg.lastThinkingHint).toBe('(¬‿¬) ruminating...');
    agg.applyEvent('message.delta', {text: '答'});
    agg.applyEvent('message.complete', {text: '答'});
    const msg = lastAssistant(agg);
    // 不产生 thinking 块（真思考走 reasoning.delta / complete.reasoning）
    expect(msg.blocks).toEqual([{type: 'text', text: '答'}]);
    // complete 清除占位
    expect(agg.lastThinkingHint).toBeNull();
  });

  it('thinking.delta 空串清除占位（API 调用结束）', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('message.start', {});
    agg.applyEvent('thinking.delta', {text: '(⊙_⊙) reflecting...'});
    agg.applyEvent('thinking.delta', {text: ''});
    expect(agg.lastThinkingHint).toBeNull();
  });

  it('reasoning.delta 聚合成 reasoning 块，与 thinking 占位互不影响', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('message.start', {});
    agg.applyEvent('reasoning.delta', {text: 'R1'});
    agg.applyEvent('thinking.delta', {text: '(◔_◔) musing...'});
    agg.applyEvent('message.complete', {text: ''});
    const msg = lastAssistant(agg);
    expect(msg.blocks).toEqual([{type: 'reasoning', text: 'R1'}]);
    expect(agg.lastThinkingHint).toBeNull();
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

describe('TimelineAggregator clarify 归位（D052）', () => {
  /** 典型 live 序列：流式文本 → clarify 工具 → 澄清卡（不建工具块） */
  function startSuspendedClarify(agg: TimelineAggregator, batch = false) {
    agg.applyEvent('message.start', {});
    agg.applyEvent('message.delta', {text: '先说明'});
    agg.applyEvent('tool.start', {tool_id: 'tc1', name: 'clarify'});
    agg.applyEvent(
      'clarify.request',
      batch
        ? {
            request_id: 'cb',
            questions: [
              {qid: 'q0', question: '问题一', choices: ['a']},
              {qid: 'q1', question: '问题二', choices: ['b']},
            ],
          }
        : {request_id: 'cs', question: '选哪个？', choices: ['A', 'B']},
    );
  }

  it('clarify 工具不建工具块（澄清卡是唯一展示），卡在消息之后', () => {
    const agg = new TimelineAggregator();
    startSuspendedClarify(agg);
    const items = agg.getItems();
    expect(items).toHaveLength(2);
    expect(items[0].kind).toBe('assistant');
    // 当前流式消息里没有 clarify 工具块
    expect((items[0] as AssistantMsg).blocks.some(b => b.type === 'tool')).toBe(
      false,
    );
    expect(items[1].kind).toBe('clarify');
    // 配对 tool_id 记到卡上
    expect((items[1] as ClarifyCardItem).linkedToolId).toBe('tc1');
  });

  it('全答完封存流式消息：续写落到卡片下方，卡获得正确时序位置', () => {
    const agg = new TimelineAggregator();
    startSuspendedClarify(agg, true);
    agg.resolveClarify('cb', 'q0', 'a');
    // 未全答：current 仍是原流式消息（续写还接在卡片前面）
    agg.applyEvent('message.delta', {text: 'x'});
    let items = agg.getItems();
    expect(items[items.length - 1].kind).toBe('clarify');
    expect(agg.isStreaming()).toBe(true);

    agg.resolveClarify('cb', 'q1', 'b');
    // 全答完：续写开新消息，追加在卡片之后（inverted 列表 = 视觉在卡片下方）
    agg.applyEvent('message.delta', {text: '收到答案，继续'});
    agg.applyEvent('message.complete', {text: ''});
    items = agg.getItems();
    expect(items.map(i => i.kind)).toEqual([
      'assistant',
      'clarify',
      'assistant',
    ]);
    const card = items[1] as ClarifyCardItem;
    expect(card.answeredQids).toEqual(['q0', 'q1']);
    expect(card.answers).toEqual({q0: 'a', q1: 'b'});
    // 封存前的 delta 归原消息，封存后的续写归新消息
    expect((items[0] as AssistantMsg).blocks).toEqual([
      {type: 'text', text: '先说明x'},
    ]);
    const tail = items[2] as AssistantMsg;
    expect(tail.blocks).toEqual([{type: 'text', text: '收到答案，继续'}]);
  });

  it('作答后到续写前的窗口 busy 不闪断（isStreaming 保持 true）', () => {
    const agg = new TimelineAggregator();
    startSuspendedClarify(agg);
    expect(agg.isStreaming()).toBe(true);
    agg.resolveClarify('cs', '', 'A');
    expect(agg.isStreaming()).toBe(true);
    agg.applyEvent('message.complete', {text: '先说明'});
    expect(agg.isStreaming()).toBe(false);
  });

  it('孤儿 complete 前缀去重：作答后 turn 立即结束不重复已展示文本', () => {
    const agg = new TimelineAggregator();
    startSuspendedClarify(agg);
    agg.resolveClarify('cs', '', 'A');
    // 无任何续写 delta，complete 带整 turn 权威文本
    agg.applyEvent('message.complete', {text: '先说明'});
    const items = agg.getItems();
    expect(items.map(i => i.kind)).toEqual(['assistant', 'clarify']);
    // 前缀已在第一条消息展示，孤儿分支截掉后无新消息
    expect((items[0] as AssistantMsg).blocks).toEqual([
      {type: 'text', text: '先说明'},
    ]);
  });

  it('孤儿 complete 前缀去重：有增量时只落增量部分', () => {
    const agg = new TimelineAggregator();
    startSuspendedClarify(agg);
    agg.resolveClarify('cs', '', 'A');
    agg.applyEvent('message.complete', {text: '先说明加结论'});
    const items = agg.getItems();
    expect(items.map(i => i.kind)).toEqual([
      'assistant',
      'clarify',
      'assistant',
    ]);
    expect((items[2] as AssistantMsg).blocks).toEqual([
      {type: 'text', text: '加结论'},
    ]);
  });

  it('tool.complete(clarify) 回显收敛：不建工具块、按 result 填答案（其他端作答）', () => {
    const agg = new TimelineAggregator();
    startSuspendedClarify(agg, true);
    agg.applyEvent('tool.complete', {
      tool_id: 'tc1',
      name: 'clarify',
      result: {answers: {q0: 'a', q1: 'b'}},
    });
    // 不补建 clarify 工具块
    expect(agg.getItems().some(i => i.kind === 'assistant')).toBe(true);
    for (const it of agg.getItems()) {
      if (it.kind === 'assistant') {
        expect(it.blocks.some(b => b.type === 'tool')).toBe(false);
      }
    }
    const card = agg.getItems().find(
      i => i.kind === 'clarify',
    ) as ClarifyCardItem;
    expect(card.answeredQids).toEqual(['q0', 'q1']);
    expect(card.answers).toEqual({q0: 'a', q1: 'b'});
    // 全答完：续写落到卡下方
    agg.applyEvent('message.delta', {text: '续'});
    const items = agg.getItems();
    expect(items[items.length - 1].kind).toBe('assistant');
    expect(items[1].kind).toBe('clarify');
  });

  it('tool.complete(clarify) 单问纯文本回显落到 qid=""', () => {
    const agg = new TimelineAggregator();
    startSuspendedClarify(agg);
    agg.applyEvent('tool.complete', {
      tool_id: 'tc1',
      name: 'clarify',
      result: '用户选的 A',
    });
    const card = agg.getItems().find(
      i => i.kind === 'clarify',
    ) as ClarifyCardItem;
    expect(card.answeredQids).toEqual(['']);
    expect(card.answers).toEqual({'': '用户选的 A'});
  });

  it('resume 快照 answers 播种 answeredQids 与展示文本', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('clarify.request', {
      request_id: 'cr',
      questions: [
        {qid: 'q0', question: '问题一', choices: ['a']},
        {qid: 'q1', question: '问题二', choices: ['b']},
      ],
      answers: {q0: '锁定值'},
    });
    const card = agg.getItems()[0] as ClarifyCardItem;
    expect(card.answeredQids).toEqual(['q0']);
    expect(card.answers).toEqual({q0: '锁定值'});
  });

  it('clarify.expire 后续写也落到卡片下方（超时 turn 继续）', () => {
    const agg = new TimelineAggregator();
    startSuspendedClarify(agg);
    agg.applyEvent('clarify.expire', {request_id: 'cs'});
    agg.applyEvent('message.delta', {text: '超时续写'});
    const items = agg.getItems();
    expect(items.map(i => i.kind)).toEqual([
      'assistant',
      'clarify',
      'assistant',
    ]);
    expect((items[1] as ClarifyCardItem).expired).toBe(true);
  });

  it('approval 点选后续写落到审批卡下方（同病同治）', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('message.start', {});
    agg.applyEvent('message.delta', {text: '要执行'});
    agg.applyEvent('approval.request', {
      request_id: 'r9',
      command: 'rm -rf /tmp/x',
    });
    agg.resolveApproval('r9', 'once');
    agg.applyEvent('message.delta', {text: '批完了'});
    const items = agg.getItems();
    expect(items.map(i => i.kind)).toEqual([
      'assistant',
      'approval',
      'assistant',
    ]);
  });

  it('已答完的卡再收到 expire 不重复封存（续写仍接新消息）', () => {
    const agg = new TimelineAggregator();
    startSuspendedClarify(agg);
    agg.resolveClarify('cs', '', 'A');
    agg.applyEvent('message.delta', {text: '续写中'});
    // 迟到的 expire：不能把续写消息再封一次
    agg.applyEvent('clarify.expire', {request_id: 'cs'});
    agg.applyEvent('message.delta', {text: '继续'});
    const items = agg.getItems();
    expect(items.map(i => i.kind)).toEqual([
      'assistant',
      'clarify',
      'assistant',
    ]);
    const tail = items[2] as AssistantMsg;
    expect(tail.blocks).toEqual([{type: 'text', text: '续写中继续'}]);
  });
});

describe('hydrate：历史 clarify 工具行合成只读卡（D052）', () => {
  it('role=tool name=clarify 单问 args → 只读已答卡，位置在行位置', () => {
    const agg = new TimelineAggregator();
    agg.hydrate([
      {role: 'user', text: '帮我看下'},
      {role: 'assistant', text: '先确认一下'},
      {role: 'tool', name: 'clarify', args: {question: '选哪个？', choices: ['A', 'B']}},
      {role: 'assistant', text: '好，按 A 处理'},
    ]);
    const items = agg.getItems();
    expect(items.map(i => i.kind)).toEqual([
      'user',
      'assistant',
      'clarify',
      'assistant',
    ]);
    const card = items[2] as ClarifyCardItem;
    expect(card.fromHistory).toBe(true);
    expect(card.questions).toEqual([
      {qid: '', question: '选哪个？', choices: ['A', 'B'], multiSelect: false},
    ]);
    expect(card.answeredQids).toEqual(['']);
    expect(card.answers).toBeUndefined();
  });

  it('批量 args（questions 数组）合成全部已答的只读卡', () => {
    const agg = new TimelineAggregator();
    agg.hydrate([
      {
        role: 'tool',
        name: 'clarify',
        args: {
          questions: [
            {question: '问题一', choices: ['a']},
            {question: '问题二'},
          ],
        },
      },
    ]);
    const card = agg.getItems()[0] as ClarifyCardItem;
    expect(card.questions).toHaveLength(2);
    expect(card.answeredQids).toHaveLength(2);
  });

  it('args 归一不出问题时兜底落回通用工具卡（不丢信息）', () => {
    const agg = new TimelineAggregator();
    agg.hydrate([{role: 'tool', name: 'clarify', args: {}}]);
    const items = agg.getItems();
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('assistant');
    const block = (items[0] as AssistantMsg).blocks[0] as {
      type: 'tool';
      tool: ToolCallBlock;
    };
    expect(block.type).toBe('tool');
    expect(block.tool.name).toBe('clarify');
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

describe('TimelineAggregator 重进会话恢复（restoreLiveTail）', () => {
  it('running turn：inflight 快照恢复用户气泡 + 流式助手尾部', () => {
    const agg = new TimelineAggregator();
    agg.hydrate([
      {role: 'user', text: '旧问题'},
      {role: 'assistant', text: '旧回答'},
      // 本轮 prompt 已在历史尾部时不重复追加
      {role: 'user', text: '继续改'},
    ]);
    agg.restoreLiveTail(true, {user: '继续改', assistant: '正在写的部分', streaming: true});
    const items = agg.getItems();
    // 尾部：用户气泡(历史里的) + 流式助手
    const tail = items[items.length - 1] as AssistantMsg;
    expect(tail.kind).toBe('assistant');
    expect(tail.streaming).toBe(true);
    expect(tail.blocks).toEqual([{type: 'text', text: '正在写的部分'}]);
    expect(agg.isStreaming()).toBe(true);
    // 后续 delta 接在恢复的尾部后面
    agg.applyEvent('message.delta', {text: '，继续'});
    const after = agg.getItems()[agg.getItems().length - 1] as AssistantMsg;
    expect(after.blocks).toEqual([{type: 'text', text: '正在写的部分，继续'}]);
  });

  it('inflight.user 不在历史尾部时补一条用户气泡', () => {
    const agg = new TimelineAggregator();
    agg.hydrate([{role: 'assistant', text: '旧回答'}]);
    agg.restoreLiveTail(true, {user: '新指令', assistant: '', streaming: true});
    const items = agg.getItems();
    expect((items[items.length - 2] as UserMsg).text).toBe('新指令');
    expect(agg.isStreaming()).toBe(true);
  });

  it('同一 turn 的本地流式尾部被保留（工具卡不丢），文本取更全方', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('message.start', {});
    agg.applyEvent('message.delta', {text: '部分'});
    agg.applyEvent('tool.start', {
      tool_id: 't1',
      name: 'write_file',
      context: 'src/a.ts',
    });
    agg.applyEvent('tool.complete', {tool_id: 't1', name: 'write_file'});
    const previous = agg.takeLiveTail();
    // 重挂：hydrate 服务端历史 + 服务端文本是本地文本的严格扩展
    agg.hydrate([{role: 'user', text: '改一下'}]);
    agg.restoreLiveTail(
      true,
      {user: '改一下', assistant: '部分更长的服务端文本', streaming: true},
      previous,
    );
    const tail = agg.getItems()[agg.getItems().length - 1] as AssistantMsg;
    expect(tail.streaming).toBe(true);
    // 工具块保留 + 文本被服务端更全文本替换（单块合并）
    expect(tail.blocks).toEqual([
      {type: 'text', text: '部分更长的服务端文本'},
      {
        type: 'tool',
        tool: expect.objectContaining({toolId: 't1', status: 'done'}),
      },
    ]);
  });

  it('服务端文本与本地尾部对不上（不同 turn）时用服务端快照重建', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('message.start', {});
    agg.applyEvent('message.delta', {text: '完全不同的旧 turn'});
    const previous = agg.takeLiveTail();
    agg.hydrate([]);
    agg.restoreLiveTail(true, {user: '新问题', assistant: '新文本'}, previous);
    const tail = agg.getItems()[agg.getItems().length - 1] as AssistantMsg;
    expect(tail.blocks).toEqual([{type: 'text', text: '新文本'}]);
  });

  it('inflight 全空且不 running 时不产生流式尾部', () => {
    const agg = new TimelineAggregator();
    agg.hydrate([{role: 'user', text: 'q'}]);
    agg.restoreLiveTail(false, null);
    expect(agg.isStreaming()).toBe(false);
  });

  it('running 但 inflight 为空（prompt 排队中）也建空流式尾部，busy 不闪断', () => {
    const agg = new TimelineAggregator();
    agg.hydrate([{role: 'user', text: 'q'}]);
    agg.restoreLiveTail(true, null);
    expect(agg.isStreaming()).toBe(true);
  });

  it('mid-turn 历史已含本轮 prompt + 工具行：不重复补用户气泡', () => {
    const agg = new TimelineAggregator();
    agg.hydrate([
      {role: 'user', text: '跑一下 lint'},
      {role: 'tool', name: 'run_command', context: 'npm run lint'},
    ]);
    agg.restoreLiveTail(true, {user: '跑一下 lint', assistant: '', streaming: true});
    const users = agg.getItems().filter(i => i.kind === 'user');
    expect(users).toHaveLength(1);
  });

  it('纯工具 turn（本地无文本）重进：同 prompt 复用本地尾部，工具卡不丢', () => {
    const agg = new TimelineAggregator();
    agg.appendUserMessage('执行命令');
    agg.applyEvent('message.start', {});
    agg.applyEvent('tool.start', {
      tool_id: 't1',
      name: 'run_command',
      context: 'npm test',
    });
    const previous = agg.takeLiveTail();
    agg.hydrate([{role: 'user', text: '执行命令'}]);
    agg.restoreLiveTail(
      true,
      {user: '执行命令', assistant: '', streaming: true},
      previous,
    );
    const tail = agg.getItems()[agg.getItems().length - 1] as AssistantMsg;
    expect(tail.fromInflightProjection).toBeFalsy();
    expect(tail.streaming).toBe(true);
    expect(
      tail.blocks.some(b => b.type === 'tool' && b.tool.toolId === 't1'),
    ).toBe(true);
  });

  it('离开期间旧 turn 已完成（文本已入历史）：同文案新 turn 不复用旧尾部', () => {
    const agg = new TimelineAggregator();
    agg.appendUserMessage('每日巡检');
    agg.applyEvent('message.start', {});
    agg.applyEvent('message.delta', {text: '旧 turn 报告'});
    const previous = agg.takeLiveTail();
    // 旧 turn 在用户离开期间完成并入库，随后 cron 同文案开了新 turn
    agg.hydrate([
      {role: 'user', text: '每日巡检'},
      {role: 'assistant', text: '旧 turn 报告'},
    ]);
    agg.restoreLiveTail(
      true,
      {user: '每日巡检', assistant: '', streaming: true},
      previous,
    );
    const tail = agg.getItems()[agg.getItems().length - 1] as AssistantMsg;
    expect(tail.fromInflightProjection).toBe(true);
  });
});

describe('工具 diff 与 complete 回填', () => {
  it('tool.complete 无 inline_diff 时从 result.diff 兜底（patch 工具）', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('message.start', {});
    agg.applyEvent('tool.start', {tool_id: 'p1', name: 'patch', context: 'a.py'});
    agg.applyEvent('tool.complete', {
      tool_id: 'p1',
      name: 'patch',
      result: {ok: true, diff: '@@ -1 +1 @@\n-old\n+new'},
      summary: '改了 1 行',
    });
    const msg = lastAssistant(agg);
    const toolBlock = msg.blocks.find(b => b.type === 'tool') as {
      type: 'tool';
      tool: ToolCallBlock;
    };
    expect(toolBlock.tool.inlineDiff).toBe('@@ -1 +1 @@\n-old\n+new');
    expect(toolBlock.tool.summary).toBe('改了 1 行');
  });

  it('inline_diff 优先于 result.diff', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('message.start', {});
    agg.applyEvent('tool.complete', {
      tool_id: 'w1',
      name: 'write_file',
      inline_diff: '┊ review diff\n@@ +1 @@\n+内容',
      result: {diff: 'RAW'},
    });
    const msg = lastAssistant(agg);
    const toolBlock = msg.blocks.find(b => b.type === 'tool') as {
      type: 'tool';
      tool: ToolCallBlock;
    };
    expect(toolBlock.tool.inlineDiff).toBe('┊ review diff\n@@ +1 @@\n+内容');
  });

  it('complete 文本是流式文本的严格前缀扩展时回填（重进竞态丢 delta）', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('message.start', {});
    agg.applyEvent('message.delta', {text: '一二三'});
    // 竞态丢了「四五六」，complete 带全量文本
    agg.applyEvent('message.complete', {text: '一二三四五六'});
    const msg = lastAssistant(agg);
    expect(msg.blocks).toEqual([{type: 'text', text: '一二三四五六'}]);
  });

  it('complete 文本与流式文本不是前缀关系时不动已流出的内容', () => {
    const agg = new TimelineAggregator();
    agg.applyEvent('message.start', {});
    agg.applyEvent('message.delta', {text: 'A'});
    agg.applyEvent('message.interim', {text: 'A', already_streamed: true});
    agg.applyEvent('message.delta', {text: 'B'});
    agg.applyEvent('message.complete', {text: '不同内容'});
    const msg = lastAssistant(agg);
    const texts = msg.blocks.filter(b => b.type === 'text');
    expect(texts).toEqual([
      {type: 'text', text: 'A'},
      {type: 'text', text: 'B'},
    ]);
  });
});

describe('hydrate：历史投影的 tool 行渲染为工具卡', () => {
  it('role=tool 行转为 done 状态工具卡，user/assistant 正常', () => {
    const agg = new TimelineAggregator();
    agg.hydrate([
      {role: 'user', text: '帮我改下代码'},
      {
        role: 'tool',
        name: 'shell',
        context: '已修改 main.ts（结果预览）',
        row_id: 7,
        args: {cmd: 'ls'},
      },
      {role: 'assistant', text: '改好了', reasoning: '先看文件'},
    ]);
    const items = agg.getItems();
    expect(items).toHaveLength(3);
    const toolMsg = items[1];
    expect(toolMsg.kind).toBe('assistant');
    const block = (toolMsg as AssistantMsg).blocks.find(b => b.type === 'tool');
    expect(block).toBeDefined();
    const tool = (block as {type: 'tool'; tool: ToolCallBlock}).tool;
    expect(tool.name).toBe('shell');
    expect(tool.status).toBe('done');
    expect(tool.toolId).toBe('hist-7');
    // reasoning 投影为 thinking 块
    const last = items[2] as AssistantMsg;
    expect(last.blocks.some(b => b.type === 'thinking')).toBe(true);
  });
});
