import React, {useMemo, useRef} from 'react';
import {PanResponder, StyleSheet, View} from 'react-native';

import {Colors} from './theme';

interface Props {
  /** 当前 contentOffset.y（配合 inverted FlatList：0 = 底部最新消息） */
  offset: number;
  contentHeight: number;
  viewportHeight: number;
  /** 拖动 thumb 时回调目标 offset（已夹取到合法范围） */
  onScrollTo: (offset: number) => void;
}

const MIN_THUMB = 36;

/**
 * 自绘可拖动滚动条：RN 原生滚动条不可拖拽，长会话无法快速定位。
 * 轨道贴列表右缘，thumb 位置与滚动偏移线性映射；因列表 inverted
 * （offset 0 = 底部最新），轨道底部对应最新会话，向上拖 = 往历史翻。
 */
export function ChatScrollbar({
  offset,
  contentHeight,
  viewportHeight,
  onScrollTo,
}: Props) {
  const scrollable = contentHeight > viewportHeight && viewportHeight > 0;
  const thumbH = scrollable
    ? Math.max(MIN_THUMB, (viewportHeight * viewportHeight) / contentHeight)
    : 0;
  const maxOffset = Math.max(contentHeight - viewportHeight, 1);
  const movable = Math.max(viewportHeight - thumbH, 1);
  // offset 0（最新）→ thumb 贴轨道底；maxOffset（最旧）→ 贴轨道顶
  const top = (1 - offset / maxOffset) * movable;

  // PanResponder 回调里要读最新 top，走 ref 避免闭包过期
  const topRef = useRef(top);
  topRef.current = top;
  const drag = useRef({startTop: 0});

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          drag.current.startTop = topRef.current;
        },
        onPanResponderMove: (_e, g) => {
          const newTop = Math.min(
            Math.max(drag.current.startTop + g.dy, 0),
            movable,
          );
          onScrollTo((1 - newTop / movable) * maxOffset);
        },
      }),
    [maxOffset, movable, onScrollTo],
  );

  if (!scrollable) {
    return null;
  }
  return (
    <View style={styles.track} pointerEvents="box-none">
      <View
        style={[styles.thumbTouch, {height: thumbH, top}]}
        {...pan.panHandlers}>
        <View style={styles.thumb} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: 16,
  },
  /** 触控热区宽 16，可视条宽 4 */
  thumbTouch: {
    position: 'absolute',
    right: 0,
    width: 16,
    justifyContent: 'center',
    alignItems: 'flex-end',
  },
  thumb: {
    width: 4,
    flex: 1,
    borderRadius: 2,
    backgroundColor: Colors.textSecondary,
    opacity: 0.5,
    marginRight: 2,
  },
});
