import {
  applyCompletion,
  executeSlash,
  looksLikeSlashCommand,
  isModelCommandInput,
  normalizeCompletionResponse,
  parseSlash,
} from '../src/rpc/slash';

describe('looksLikeSlashCommand 行首斜杠命令判定', () => {
  it('行首命令命中', () => {
    expect(looksLikeSlashCommand('/help')).toBe(true);
    expect(looksLikeSlashCommand('/model gpt-x')).toBe(true);
    expect(looksLikeSlashCommand('/')).toBe(true);
    expect(looksLikeSlashCommand('/compact ')).toBe(true);
  });

  it('句中斜杠与路径不命中', () => {
    expect(looksLikeSlashCommand('看看 /usr/local/bin')).toBe(false);
    expect(looksLikeSlashCommand('check src/foo/bar')).toBe(false);
    expect(looksLikeSlashCommand('帮我 /clean 清理')).toBe(false);
    expect(looksLikeSlashCommand('普通消息')).toBe(false);
    expect(looksLikeSlashCommand('')).toBe(false);
  });
});

describe('isModelCommandInput /model 特判', () => {
  it('裸命令与带参数都命中，其它命令不命中', () => {
    expect(isModelCommandInput('/model')).toBe(true);
    expect(isModelCommandInput('/model gpt-x')).toBe(true);
    expect(isModelCommandInput('/modeling')).toBe(false);
    expect(isModelCommandInput('/help')).toBe(false);
  });
});

describe('normalizeCompletionResponse', () => {
  it('正常响应透传字段', () => {
    const r = normalizeCompletionResponse({
      items: [
        {text: 'goal', display: '/goal', meta: 'Set a goal', kind: 'command'},
        {text: '/density', display: '/density', meta: 'density', kind: 'command'},
      ],
      replace_from: 1,
    });
    expect(r.items).toHaveLength(2);
    expect(r.replaceFrom).toBe(1);
    expect(r.items[0]).toEqual({
      text: 'goal',
      display: '/goal',
      meta: 'Set a goal',
      kind: 'command',
    });
  });

  it('缺字段/非法项兜底为空补全', () => {
    expect(normalizeCompletionResponse(undefined)).toEqual({
      items: [],
      replaceFrom: 1,
    });
    expect(normalizeCompletionResponse({items: 'nope'})).toEqual({
      items: [],
      replaceFrom: 1,
    });
    expect(
      normalizeCompletionResponse({items: [{}, {text: 'ok'}], replace_from: 6})
        .items,
    ).toHaveLength(1);
  });
});

describe('applyCompletion 替换语义', () => {
  it('名称阶段（replaceFrom=1）保留 "/"', () => {
    expect(applyCompletion('/g', 1, 'goal')).toBe('/goal');
  });

  it('参数阶段只替换最后一个 token', () => {
    expect(applyCompletion('/cron ad', 6, 'add')).toBe('/cron add');
  });

  it('registry 项 text 不带斜杠、TUI extras 带斜杠都能正确拼接', () => {
    expect(applyCompletion('/det', 1, '/details')).toBe('/details');
    expect(applyCompletion('/', 1, 'goal')).toBe('/goal');
  });

  it('replaceFrom 越界时收敛到合法区间', () => {
    // 超界收敛到输入末尾（等价追加）；负值收敛到 0
    expect(applyCompletion('/g', 99, 'goal')).toBe('/ggoal');
    expect(applyCompletion('/g', -1, 'goal')).toBe('goal');
  });
});

describe('parseSlash', () => {
  it('拆命令名与参数', () => {
    expect(parseSlash('/model gpt-x')).toEqual({name: 'model', arg: 'gpt-x'});
    expect(parseSlash('/help')).toEqual({name: 'help', arg: ''});
    expect(parseSlash('/new  my room ')).toEqual({name: 'new', arg: 'my room'});
    expect(parseSlash('')).toEqual({name: '', arg: ''});
  });
});

describe('executeSlash 执行流水线', () => {
  type CallLog = {method: string; params: Record<string, unknown>};

  function makeHarness(dispatchResponse: unknown) {
    const calls: CallLog[] = [];
    const sys: string[] = [];
    const sent: string[] = [];
    const call = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('slash.exec rejected');
      })
      .mockImplementationOnce(() => Promise.resolve(dispatchResponse));
    const run = (command: string) =>
      executeSlash({
        command,
        sessionId: 's1',
        call: (method, params) => {
          calls.push({method, params});
          return call(method, params);
        },
        callbacks: {
          sys: t => sys.push(t),
          send: async m => {
            sent.push(m);
          },
        },
      });
    return {run, calls, sys, sent, call};
  }

  it('slash.exec 成功：输出进系统行，不再走 dispatch', async () => {
    const calls: CallLog[] = [];
    const sys: string[] = [];
    const call = jest.fn().mockResolvedValue({output: 'model = gpt-x'});
    const result = await executeSlash({
      command: '/model gpt-x',
      sessionId: 's1',
      call: (method, params) => {
        calls.push({method, params});
        return call(method, params);
      },
      callbacks: {sys: t => sys.push(t), send: async () => undefined},
    });
    expect(result).toBe('done');
    expect(call).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual({
      method: 'slash.exec',
      params: {command: 'model gpt-x', session_id: 's1'},
    });
    expect(sys).toEqual(['model = gpt-x']);
  });

  it('exec 失败回退 dispatch：send 型把 message 交给 send 回调', async () => {
    const h = makeHarness({type: 'send', message: '  请帮我清理  '});
    const result = await h.run('/clean');
    expect(result).toBe('sent');
    expect(h.calls[1]).toEqual({
      method: 'command.dispatch',
      params: {name: 'clean', arg: '', session_id: 's1'},
    });
    expect(h.sent).toEqual(['请帮我清理']);
  });

  it('skill 型：先出加载提示再 send', async () => {
    const h = makeHarness({type: 'skill', name: 'clean', message: 'skill prompt'});
    const result = await h.run('/clean');
    expect(result).toBe('sent');
    expect(h.sys).toContain('⚡ 加载技能: clean');
    expect(h.sent).toEqual(['skill prompt']);
  });

  it('alias 型：递归执行目标命令', async () => {
    const calls: CallLog[] = [];
    const sys: string[] = [];
    const call = jest
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error('rejected')))
      .mockImplementationOnce(() => Promise.resolve({type: 'alias', target: 'new'}))
      .mockImplementationOnce(() => Promise.resolve({output: 'new session'}));
    const result = await executeSlash({
      command: '/reset',
      sessionId: 's1',
      call: (method, params) => {
        calls.push({method, params});
        return call(method, params);
      },
      callbacks: {sys: t => sys.push(t), send: async () => undefined},
    });
    expect(result).toBe('done');
    expect(sys).toEqual(['new session']);
    expect(calls[2]).toEqual({
      method: 'slash.exec',
      params: {command: 'new', session_id: 's1'},
    });
  });

  it('plugin 型：直接输出', async () => {
    const h = makeHarness({type: 'plugin', output: 'plugin ok'});
    const result = await h.run('/myplug do it');
    expect(result).toBe('done');
    expect(h.calls[1]).toEqual({
      method: 'command.dispatch',
      params: {name: 'myplug', arg: 'do it', session_id: 's1'},
    });
    expect(h.sys).toEqual(['plugin ok']);
  });

  it('双失败：报错进系统行', async () => {
    const calls: CallLog[] = [];
    const sys: string[] = [];
    const call = jest.fn().mockRejectedValue(new Error('boom'));
    const result = await executeSlash({
      command: '/nope',
      sessionId: 's1',
      call: (method, params) => {
        calls.push({method, params});
        return call(method, params);
      },
      callbacks: {sys: t => sys.push(t), send: async () => undefined},
    });
    expect(result).toBe('error');
    expect(sys[0]).toBe('错误: boom');
    expect(calls).toHaveLength(2);
  });

  it('空命令名直接报错', async () => {
    const sys: string[] = [];
    const result = await executeSlash({
      command: '/',
      sessionId: 's1',
      call: async () => ({}),
      callbacks: {sys: t => sys.push(t), send: async () => undefined},
    });
    expect(result).toBe('error');
    expect(sys).toEqual(['空的斜杠命令']);
  });
});
