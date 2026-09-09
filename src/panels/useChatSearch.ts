/**
 * useChatSearch — 聊天记录查找的状态连线（ChatScreen / ChatPane 共用）。
 * 持有搜索条开关、关键词、命中表与当前命中；↑/↓ 循环跳转经 TimelineView
 * 的 scrollToMessage 定位并高亮。输入变化即自动跳到第一个匹配（经 ref 读
 * 最新命中表——流式期间 items 持续更新，若作为 effect 依赖会反复拉回第一处）。
 */

import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {RefObject} from 'react';

import type {TimelineViewHandle} from './TimelineView';
import {useChatStore} from '../store/chat';
import type {TimelineItem} from '../rpc/types';
import {searchTimeline} from '../utils/timelineSearch';

const EMPTY_ITEMS: TimelineItem[] = [];

export function useChatSearch(
  sessionId: string,
  timelineRef: RefObject<TimelineViewHandle | null>,
) {
  const items = useChatStore(s => s.bySession[sessionId]?.items);
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const hits = useMemo(
    () => searchTimeline(items ?? EMPTY_ITEMS, query),
    [items, query],
  );
  const hitsRef = useRef(hits);
  hitsRef.current = hits;

  const jumpTo = useCallback(
    (index: number) => {
      const list = hitsRef.current;
      if (list.length === 0) {
        return;
      }
      // 循环取模：越过首尾回绕到另一端
      const next = ((index % list.length) + list.length) % list.length;
      setActive(next);
      const id = list[next];
      setHighlightId(id);
      timelineRef.current?.scrollToMessage(id);
    },
    [timelineRef],
  );

  // 关键词变化：有命中自动跳第一处；无命中清高亮（依赖仅 query，见文件头）
  useEffect(() => {
    if (!query.trim()) {
      setHighlightId(null);
      setActive(0);
      return;
    }
    if (hitsRef.current.length > 0) {
      jumpTo(0);
    } else {
      setHighlightId(null);
    }
  }, [query, jumpTo]);

  const show = useCallback(() => setVisible(true), []);
  const hide = useCallback(() => {
    setVisible(false);
    setQuery('');
    setActive(0);
    setHighlightId(null);
  }, []);

  return {
    visible,
    show,
    hide,
    query,
    setQuery,
    /** 命中总数（搜索条 n/m 显示） */
    total: hits.length,
    /** 当前命中序号（0 基） */
    activeIndex: active,
    onPrev: useCallback(() => jumpTo(active - 1), [jumpTo, active]),
    onNext: useCallback(() => jumpTo(active + 1), [jumpTo, active]),
    /** 当前命中消息 id（TimelineView 描边高亮用） */
    highlightId,
  };
}
