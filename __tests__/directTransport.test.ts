/**
 * DirectTransport（直连 gateway）单测：
 * token 自动提取 / 手动兜底 / 失败路径 / URL 拼装。
 * fetch 按 D028 教训走 globalThis 结构断言 mock（tsconfig 无 dom types）。
 */

import {DirectTransport} from '../src/ssh/directTransport';

const originalFetch = (globalThis as {fetch?: unknown}).fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  (globalThis as {fetch?: unknown}).fetch = fetchMock;
});

afterEach(() => {
  (globalThis as {fetch?: unknown}).fetch = originalFetch;
});

describe('DirectTransport（直连 gateway）', () => {
  it('自动提取 token：GET 首页 → wsUrl/httpUrl/token', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<html>__HERMES_SESSION_TOKEN__="tok123"</html>',
    });
    const t = new DirectTransport({host: '192.168.1.5', port: 9119});
    const r = await t.connect();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://192.168.1.5:9119',
      expect.anything(),
    );
    expect(r).toEqual({
      wsUrl: 'ws://192.168.1.5:9119/api/ws?token=tok123',
      httpUrl: 'http://192.168.1.5:9119',
      token: 'tok123',
    });
  });

  it('手动 token：跳过 fetch，直接拼 URL', async () => {
    const t = new DirectTransport({
      host: '127.0.0.1',
      port: 9119,
      token: 'manual',
    });
    const r = await t.connect();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.wsUrl).toBe('ws://127.0.0.1:9119/api/ws?token=manual');
    expect(r.httpUrl).toBe('http://127.0.0.1:9119');
    expect(r.token).toBe('manual');
  });

  it('首页无 token → 报错提示可手动填写', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<html>没有 token</html>',
    });
    const t = new DirectTransport({host: '127.0.0.1', port: 9119});
    await expect(t.connect()).rejects.toThrow('手动填写');
  });

  it('HTTP 非 2xx → 报错带状态码', async () => {
    fetchMock.mockResolvedValue({ok: false, status: 404});
    const t = new DirectTransport({host: '127.0.0.1', port: 9119});
    await expect(t.connect()).rejects.toThrow('HTTP 404');
  });

  it('网络错误 → 包装为「无法连接 gateway」', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const t = new DirectTransport({host: '10.255.255.1', port: 9119});
    await expect(t.connect()).rejects.toThrow('无法连接 gateway');
  });

  it('disconnect 幂等无资源释放', async () => {
    const t = new DirectTransport({host: '127.0.0.1', port: 9119, token: 'x'});
    await expect(t.disconnect()).resolves.toBeUndefined();
  });
});
