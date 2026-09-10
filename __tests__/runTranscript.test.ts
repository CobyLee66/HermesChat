/**
 * projectRunMessages（cron 运行详情只读投影）纯逻辑测试：
 * - role 过滤：tool 等行不进只读视图
 * - display_kind='hidden' 跳过；压缩摘要（display_content）转 system 灰条
 * - content JSON parts 数组拍平（coerceContentText 复用）
 * - 空文本跳过、timestamp 透传
 */

import {projectRunMessages, type RawSessionMessageRow} from '../src/rpc/restSessions';

describe('projectRunMessages', () => {
  it('只保留 user/assistant/system，tool 行不渲染', () => {
    const rows: RawSessionMessageRow[] = [
      {role: 'user', content: '跑一下日报'},
      {role: 'tool', content: '{"cmd":"ls"}', name: 'bash'},
      {role: 'assistant', content: '日报已生成'},
    ];
    const out = projectRunMessages(rows);
    expect(out.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(out.map(m => m.text)).toEqual(['跑一下日报', '日报已生成']);
  });

  it('display_kind=hidden 跳过；压缩摘要行取 display_content 转 system', () => {
    const rows: RawSessionMessageRow[] = [
      {role: 'user', content: '早期内容', display_kind: 'hidden'},
      {
        role: 'user',
        content: '{"physical":true}',
        display_content: '（更早的对话已压缩为摘要）',
      },
      {role: 'assistant', content: '当前输出'},
    ];
    const out = projectRunMessages(rows);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({role: 'system', text: '（更早的对话已压缩为摘要）'});
    expect(out[1]).toMatchObject({role: 'assistant', text: '当前输出'});
  });

  it('content 为 JSON parts 数组时拍平为纯文本', () => {
    const rows: RawSessionMessageRow[] = [
      {
        role: 'user',
        content: JSON.stringify([
          {type: 'text', text: '看这张图'},
          {type: 'image_url', image_url: {url: 'http://x/img.png'}},
        ]),
      },
    ];
    expect(projectRunMessages(rows)[0]?.text).toBe('看这张图\nhttp://x/img.png');
  });

  it('空文本与空 display_content 跳过；timestamp 有效时透传', () => {
    const rows: RawSessionMessageRow[] = [
      {role: 'assistant', content: '   '},
      {role: 'user', content: '', display_content: ''},
      {role: 'system', content: '会话开始', timestamp: 1780000000},
      {role: 'user', content: '无时间戳'},
    ];
    const out = projectRunMessages(rows);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({role: 'system', text: '会话开始', timestamp: 1780000000});
    expect(out[1]).toMatchObject({role: 'user', text: '无时间戳'});
    expect(out[1].timestamp).toBeUndefined();
  });

  it('rows 为 null/undefined 时返回空数组', () => {
    expect(projectRunMessages(null as unknown as RawSessionMessageRow[])).toEqual([]);
    expect(projectRunMessages(undefined as unknown as RawSessionMessageRow[])).toEqual([]);
  });
});
