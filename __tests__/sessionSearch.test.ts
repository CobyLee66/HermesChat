import {filterSessionsByQuery, sessionMatchesQuery} from '../src/utils/sessionSearch';
import type {SessionListRow} from '../src/rpc/types';

function row(partial: Partial<SessionListRow>): SessionListRow {
  return {
    id: 's1',
    title: '',
    preview: '',
    started_at: 1757400000,
    message_count: 3,
    source: 'tui',
    ...partial,
  };
}

const FIXTURES: SessionListRow[] = [
  row({id: 'a', title: '清理服务器日志', preview: '今晚执行清理任务'}),
  row({id: 'b', title: '', preview: '讨论季度预算报表'}),
  row({id: 'c', title: 'Weekly Report', preview: ''}),
];

describe('sessionSearch 会话列表搜索', () => {
  test('标题命中（大小写不敏感）', () => {
    expect(filterSessionsByQuery(FIXTURES, '清理').map(r => r.id)).toEqual(['a']);
    expect(filterSessionsByQuery(FIXTURES, 'weekly').map(r => r.id)).toEqual(['c']);
  });

  test('摘要命中', () => {
    expect(filterSessionsByQuery(FIXTURES, '预算').map(r => r.id)).toEqual(['b']);
  });

  test('空标题按显示文案「未命名会话」参与匹配', () => {
    expect(sessionMatchesQuery(FIXTURES[1], '未命名')).toBe(true);
    expect(sessionMatchesQuery(FIXTURES[0], '未命名')).toBe(false);
  });

  test('query 带首尾空白仍可命中；纯空白 query 不过滤', () => {
    expect(filterSessionsByQuery(FIXTURES, ' 清理 ').map(r => r.id)).toEqual(['a']);
    expect(filterSessionsByQuery(FIXTURES, '   ').map(r => r.id)).toEqual(['a', 'b', 'c']);
  });

  test('无命中返回空数组；保持入参顺序', () => {
    expect(filterSessionsByQuery(FIXTURES, '不存在')).toEqual([]);
    expect(filterSessionsByQuery(FIXTURES, 'weekly').map(r => r.id)).toEqual(['c']);
  });
});
