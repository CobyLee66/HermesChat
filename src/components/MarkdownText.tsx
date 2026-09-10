import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Platform, ScrollView, ScrollViewInstance, StyleSheet, View} from 'react-native';
import Markdown from 'react-native-markdown-display';
import {GestureDetector, usePanGesture} from 'react-native-gesture-handler';

import {Colors} from './theme';
import {rewriteListMarkers} from '../utils/markdownLists';

interface Props {
  text: string;
}

/** 惯性滚动的停止速度（points/s）与衰减系数（越大停得越快）。 */
const FLING_STOP_VELOCITY = 60;
const FLING_DECAY = 5;

/**
 * 表格横向滚动容器。
 * Android 上外层聊天列表（inverted 竖向 FlatList）的原生触摸拦截先于子级
 * 判定：手指垂直位移过 touchSlop 即抢走整个手势，人手横向拖动几乎必然带
 * 早期垂直抖动，于是表格「大部分拖不动、偶尔点击重试后能拖」；嵌套滚动
 * 机制不跨轴生效（RN 0.87 已默认开启仍复现，见 D039）。因此 Android 禁用
 * 原生滚动，改用方向锁定的 Pan 手势驱动 scrollTo：水平位移过阈值才激活
 * （激活后阻断外层拦截），垂直位移过阈值立刻 fail 让路给列表；惯性滚动用
 * 速度衰减补偿（scrollEnabled=false 时原生 fling 不可用）。
 * iOS 无此拦截问题，保持原生滚动（惯性/回弹/滚动条全原生）；web 走
 * MarkdownText.web.tsx 的 CSS overflow-x，与本文件无关。
 */
function TableScroll({
  minWidth,
  children,
}: {
  minWidth: number;
  children: React.ReactNode;
}) {
  const isAndroid = Platform.OS === 'android';
  const scrollRef = useRef<ScrollViewInstance>(null);
  // 视口宽（ScrollView）/ 内容宽（表格）决定可滚范围；x 为当前偏移。
  // 都走 ref：手势回调里取最新值，且不因布局回调用 setState 打断手势
  const bounds = useRef({viewport: 0, content: 0, x: 0});
  const dragStart = useRef(0);
  const rafRef = useRef(0);

  const clampScroll = useCallback((x: number) => {
    const maxX = Math.max(bounds.current.content - bounds.current.viewport, 0);
    bounds.current.x = Math.min(Math.max(x, 0), maxX);
    scrollRef.current?.scrollTo({x: bounds.current.x, y: 0, animated: false});
  }, []);

  // 手势结束后的速度衰减惯性；到边界或速度足够小即停
  const decayScroll = useCallback(
    (velocity: number) => {
      cancelAnimationFrame(rafRef.current);
      let v = velocity;
      let last = Date.now();
      const step = () => {
        const now = Date.now();
        const dt = Math.min(now - last, 32) / 1000;
        last = now;
        const next = bounds.current.x + v * dt;
        const maxX = Math.max(
          bounds.current.content - bounds.current.viewport,
          0,
        );
        v *= Math.exp(-dt * FLING_DECAY);
        clampScroll(next);
        if (next <= 0 || next >= maxX || Math.abs(v) < FLING_STOP_VELOCITY) {
          return;
        }
        rafRef.current = requestAnimationFrame(step);
      };
      rafRef.current = requestAnimationFrame(step);
    },
    [clampScroll],
  );

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const pan = usePanGesture({
    activeOffsetX: [-10, 10],
    failOffsetY: [-8, 8],
    onBegin: () => {
      cancelAnimationFrame(rafRef.current);
      dragStart.current = bounds.current.x;
      scrollRef.current?.flashScrollIndicators();
    },
    onUpdate: e => clampScroll(dragStart.current - e.translationX),
    onDeactivate: e => {
      // canceled = 被 fail/cancel（未真正拖动），不带速度
      if (!e.canceled) {
        decayScroll(-e.velocityX);
      }
    },
  });

  const scrollView = (
    <ScrollView
      ref={scrollRef}
      horizontal
      style={styles.tableScroll}
      showsHorizontalScrollIndicator={!isAndroid}
      scrollEnabled={!isAndroid}
      onLayout={e => {
        bounds.current.viewport = e.nativeEvent.layout.width;
        clampScroll(bounds.current.x);
      }}>
      <View
        style={[mdStyles.table, minWidth > 0 ? {minWidth} : null]}
        onLayout={e => {
          bounds.current.content = e.nativeEvent.layout.width;
          clampScroll(bounds.current.x);
        }}>
        {children}
      </View>
    </ScrollView>
  );

  if (!isAndroid) {
    return scrollView;
  }
  return <GestureDetector gesture={pan}>{scrollView}</GestureDetector>;
}

/**
 * 助手消息的 markdown 渲染（react-native-markdown-display）。
 * - 列表标记在渲染前改写为普通文本前缀（见 utils/markdownLists.ts）：
 *   库的 bullet_list 布局在安卓端会把气泡压缩成窄竖条，改写成普通段落
 *   后按已验证宽度正常的路径渲染；
 * - 表格用自定义 rule 包一层横向滚动容器（TableScroll，Android 上为
 *   手势驱动，见其注释）：列宽随内容（flexShrink:0），窄表至少撑满气泡
 *   内容宽（minWidth），宽表可左右滑动；
 * - 链接沿用库默认行为（系统浏览器打开）；
 * - 文本选择复制由 Bubble 长按菜单接管（全选/部分选择），这里不做 selectable
 *   —— RN 的 Text 选择按单个控件走，跨段落/表格会断，交给整条纯文本。
 */
export function MarkdownText({text}: Props) {
  // 量取气泡内容宽度，作为表格的最小宽度基准
  const [width, setWidth] = useState(0);
  // 列表标记改写（纯文本变换，随消息稳定）
  const content = useMemo(() => rewriteListMarkers(text), [text]);
  const rules = useMemo(
    () => ({
      // eslint-disable-next-line react/no-unstable-nested-components -- 库的渲染规则是 render prop，返回的是常驻 TableScroll 元素
      table: (node: {key: string}, children: React.ReactNode) => (
        <TableScroll key={node.key} minWidth={width}>
          {children}
        </TableScroll>
      ),
    }),
    [width],
  );
  return (
    <View
      onLayout={e => {
        const w = e.nativeEvent.layout.width;
        if (w > 0 && w !== width) {
          setWidth(w);
        }
      }}>
      <Markdown style={mdStyles} rules={rules}>
        {content}
      </Markdown>
    </View>
  );
}

const mono = Platform.select({ios: 'Courier', android: 'monospace'});

/** 覆盖库默认样式（按元素名整键替换），配色对齐浅色 QQ 风主题。 */
const mdStyles = StyleSheet.create({
  body: {fontSize: 16, lineHeight: 23, color: Colors.text},
  heading1: {fontSize: 24, fontWeight: '700', marginVertical: 6},
  heading2: {fontSize: 20, fontWeight: '700', marginVertical: 5},
  heading3: {fontSize: 17, fontWeight: '600', marginVertical: 4},
  heading4: {fontSize: 16, fontWeight: '600', marginVertical: 3},
  heading5: {fontSize: 14, fontWeight: '600', marginVertical: 2},
  heading6: {fontSize: 13, fontWeight: '600', marginVertical: 2},
  hr: {backgroundColor: Colors.border, height: StyleSheet.hairlineWidth},
  strong: {fontWeight: '700'},
  em: {fontStyle: 'italic'},
  s: {textDecorationLine: 'line-through'},
  link: {color: Colors.accentDark},
  blockquote: {
    backgroundColor: Colors.thinkingBg,
    borderColor: Colors.border,
    borderLeftWidth: 3,
    paddingHorizontal: 8,
  },
  bullet_list: {marginVertical: 2},
  ordered_list: {marginVertical: 2},
  list_item: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    marginVertical: 1,
  },
  bullet_list_icon: {marginLeft: 6, marginRight: 8},
  bullet_list_content: {flex: 1},
  ordered_list_icon: {marginLeft: 6, marginRight: 8},
  ordered_list_content: {flex: 1},
  code_inline: {
    backgroundColor: Colors.thinkingBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    borderRadius: 4,
    paddingHorizontal: 4,
    fontFamily: mono,
    fontSize: 14,
  },
  code_block: {
    backgroundColor: Colors.thinkingBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    borderRadius: 8,
    padding: 10,
    fontFamily: mono,
    fontSize: 13,
    lineHeight: 19,
  },
  fence: {
    backgroundColor: Colors.thinkingBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    borderRadius: 8,
    padding: 10,
    fontFamily: mono,
    fontSize: 13,
    lineHeight: 19,
  },
  table: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    borderRadius: 6,
    marginVertical: 6,
  },
  thead: {backgroundColor: Colors.thinkingBg},
  tbody: {},
  tr: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  /** 列宽随内容、不压缩（flexShrink:0），超出气泡宽度时整体横向滚动 */
  th: {
    flexShrink: 0,
    minWidth: 72,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  td: {
    flexShrink: 0,
    minWidth: 72,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
});

const styles = StyleSheet.create({
  tableScroll: {marginVertical: 2},
});
