/**
 * 会话列表排序档位测试：
 * - sortSessionRows：recent 保持引用（store 已是最近活跃序）、created 按
 *   started_at 降序且不改输入
 * - 排序档位持久化：setSortMode 落盘、loadSortModePreference 恢复、
 *   损坏/未知值忽略回默认
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type {SessionListRow} from '../src/rpc/types';
import {useSessionsStore} from '../src/store/sessions';
import {
  SESSION_SORT_STORAGE_KEY,
  isSessionSortMode,
  sortSessionRows,
} from '../src/utils/sessionSort';

function row(id: string, startedAt: number): SessionListRow {
  return {
    id,
    title: `t-${id}`,
    preview: '',
    started_at: startedAt,
    message_count: 1,
    source: 'tui',
  };
}

describe('sortSessionRows', () => {
  const rows = [row('a', 100), row('b', 300), row('c', 200)];

  it('recent：原样返回（同一引用，store 已按最近活跃排序）', () => {
    expect(sortSessionRows(rows, 'recent')).toBe(rows);
  });

  it('created：started_at 降序，不改输入数组', () => {
    const out = sortSessionRows(rows, 'created');
    expect(out.map(r => r.id)).toEqual(['b', 'c', 'a']);
    expect(rows.map(r => r.id)).toEqual(['a', 'b', 'c']);
    expect(out).not.toBe(rows);
  });

  it('created：started_at 缺失/0 兜底排最后', () => {
    const out = sortSessionRows([row('x', 0), row('y', 5), row('z', 3)], 'created');
    expect(out.map(r => r.id)).toEqual(['y', 'z', 'x']);
  });
});

describe('isSessionSortMode', () => {
  it('只认 recent/created', () => {
    expect(isSessionSortMode('recent')).toBe(true);
    expect(isSessionSortMode('created')).toBe(true);
    expect(isSessionSortMode('both')).toBe(false);
    expect(isSessionSortMode('')).toBe(false);
    expect(isSessionSortMode(null)).toBe(false);
    expect(isSessionSortMode(undefined)).toBe(false);
  });
});

describe('排序档位持久化', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    useSessionsStore.setState({
      byProfile: {},
      loading: false,
      error: null,
      stale: false,
      nsMap: null,
      sortMode: 'recent',
    });
  });

  it('setSortMode：状态立即生效并落盘', async () => {
    useSessionsStore.getState().setSortMode('created');
    expect(useSessionsStore.getState().sortMode).toBe('created');
    // zustand setState 同步先落，AsyncStorage 写异步完成——留一个微任务拍
    await Promise.resolve();
    expect(await AsyncStorage.getItem(SESSION_SORT_STORAGE_KEY)).toBe('created');
  });

  it('loadSortModePreference：恢复持久化档位', async () => {
    await AsyncStorage.setItem(SESSION_SORT_STORAGE_KEY, 'created');
    await useSessionsStore.getState().loadSortModePreference();
    expect(useSessionsStore.getState().sortMode).toBe('created');
  });

  it('损坏/未知存储值忽略，保持默认 recent', async () => {
    await AsyncStorage.setItem(SESSION_SORT_STORAGE_KEY, '{broken');
    await useSessionsStore.getState().loadSortModePreference();
    expect(useSessionsStore.getState().sortMode).toBe('recent');
  });
});
