/**
 * TimelineView — 聊天时间线面板（inverted FlatList + 条目渲染 + 自绘滚动条 +
 * 回到底部 + 斜杠补全浮层挂点）。手机 ChatScreen 与桌面聊天列共用。
 *
 * 贴底跟随策略（src/utils/timelineFollow.ts）：inverted 列表 offset 即距视觉
 * 底部的距离——距底 ≤ 阈值视为「在底部」，流式等内容增长时显式钉底；用户上滑
 * 离开底部即暂停跟随，仅对流式增长且用户停滚后做锚定补偿（内容在 offset 0 侧
 * 生长会把既有内容往新消息方向推，不补偿则阅读位置被拖走）；历史浏览中新
 * cell 挂载/图片加载导致的高度增长在视觉顶端一侧、不移动视口，不补偿（补偿
 * 会把用户向前瞬移，是首次上滚抖动的根因）；滚回底部自动恢复。
 *
 * 斜杠补全浮层必须挂在本面板的列表容器内（absolute 子元素渲染在父容器边界内，
 * Android 触摸命中才有保障）——通过 slashOverlay 插槽由调用方传入。
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  FlatList,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import {ApprovalCard} from '../components/ApprovalCard';
import {Bubble} from '../components/Bubble';
import {ChatImage} from '../components/ChatImage';
import {ChatScrollbar} from '../components/ChatScrollbar';
import {ClarifyCard} from '../components/ClarifyCard';
import {FileRefCard} from '../components/FileRefCard';
import {Colors} from '../components/theme';
import {StreamCursor, ThinkingBlock} from '../components/ThinkingBlock';
import {ToolCallCard} from '../components/ToolCallCard';
import {useT} from '../i18n';
import {useChatStore} from '../store/chat';
import {
  isAtBottom,
  offsetUntouched,
  SCROLL_QUIET_MS,
  shouldPinToBottom,
  shouldRestoreAnchor,
} from '../utils/timelineFollow';
import type {AssistantBlock, AssistantMsg, TimelineItem} from '../rpc/types';

const EMPTY_ITEMS: TimelineItem[] = [];

/** 发送消息等主动动作经此回到最新消息（父组件持 ref 调用） */
export type TimelineViewHandle = {
  revealBottom: () => void;
  /** 聊天记录查找：滚动定位到某条消息并置视口中部（未找到静默跳过） */
  scrollToMessage: (id: string) => void;
};

/** web 分支用：下一帧执行（此刻布局与 Chrome scroll anchoring 调整已完成） */
function nextFrame(fn: () => void): void {
  const raf = (globalThis as {requestAnimationFrame?: (cb: () => void) => number})
    .requestAnimationFrame;
  if (typeof raf === 'function') {
    raf(fn);
  } else {
    setTimeout(fn, 16);
  }
}

type TimelineViewProps = {
  sessionId: string;
  /** 是否显示工具调用/思考/推理等非对话内容 */
  showDetail: boolean;
  /** 助手气泡长按选择文本（手机端）；桌面端不传即关闭该交互 */
  onSelectText?: (text: string) => void;
  /** 聊天记录查找的当前命中消息（accent 描边高亮；null/不传无高亮） */
  highlightMessageId?: string | null;
  slashOverlay?: React.ReactNode;
};

export const TimelineView = forwardRef<TimelineViewHandle, TimelineViewProps>(
  function TimelineView(
    {sessionId, showDetail, onSelectText, highlightMessageId, slashOverlay},
    ref,
  ) {
    const chat = useChatStore(s => s.bySession[sessionId]);
    const respondApproval = useChatStore(s => s.respondApproval);
    const submitClarify = useChatStore(s => s.submitClarify);
    const t = useT();

    const items = useMemo(() => chat?.items ?? EMPTY_ITEMS, [chat?.items]);
    const invertedItems = useMemo(() => [...items].reverse(), [items]);

    /** 列表滚动状态：驱动自绘滚动条与「回到底部」按钮 */
    const [scroll, setScroll] = useState({offset: 0, content: 0, viewport: 0});
    const listRef = useRef<FlatList<TimelineItem>>(null);

    /** 贴底跟随态（ref 避免流式高频重渲染）：初始与切会话时跟随 */
    const followRef = useRef(true);
    const lastOffsetRef = useRef(0);
    const lastContentRef = useRef(0);
    /** 会话是否流式进行中（ref：onContentSizeChange 回调里读最新值） */
    const streamingRef = useRef(false);
    /** 最近一次 scroll 事件时刻（判定「滚动中」） */
    const lastScrollAtRef = useRef(0);
    /** scrollToIndex 失败重试计数（scrollToMessage 每次发起时清零） */
    const scrollRetryRef = useRef(0);

    // 桌面切会话复用本组件实例（sessionId 变化不 remount），新会话一律重新贴底
    useEffect(() => {
      followRef.current = true;
      lastOffsetRef.current = 0;
      lastContentRef.current = 0;
    }, [sessionId]);

    useEffect(() => {
      streamingRef.current = chat?.busy ?? false;
    }, [chat?.busy]);

    const scrollTo = useCallback((offset: number, animated = false) => {
      listRef.current?.scrollToOffset({offset, animated});
    }, []);

    /**
     * 内容增长：跟随→钉底；流式中且已停滚的非跟随态→锚定补偿。其余一律
     * 不做程序性滚动：历史浏览中新 cell 挂载/图片加载导致的增长（非流式）
     * 在视觉顶端一侧、不移动视口，补偿反而会向前瞬移并打断惯性滚动（首次
     * 上滚抖动根因）；滚动未停时无法区分增长来源（流式中上滑滚入未挂载区
     * 两者并存），交还给用户手势与平台 anchoring。代价：流式结束后的
     * history 重建（D031）若恰逢用户停在历史位置，可能有一次不补偿的位移，
     * 可接受。
     */
    const handleContentGrowth = useCallback(
      (deltaH: number) => {
        if (shouldPinToBottom(followRef.current, deltaH)) {
          listRef.current?.scrollToOffset({offset: 0, animated: false});
          return;
        }
        const scrolling = Date.now() - lastScrollAtRef.current < SCROLL_QUIET_MS;
        if (
          !shouldRestoreAnchor(
            followRef.current,
            deltaH,
            streamingRef.current,
            scrolling,
          )
        ) {
          return;
        }
        const atGrowth = lastOffsetRef.current;
        if (Platform.OS === 'web') {
          // Chrome scroll anchoring 若已调整 scrollTop 会先产生 scroll 事件，
          // 而 onScroll 有 32ms 节流——下一帧读滚动节点真实值判断，未被调整
          // （也无用户滚动）才补偿，避免双重补偿
          nextFrame(() => {
            const node = listRef.current?.getScrollableNode() as unknown as
              | {scrollTop?: number}
              | null
              | undefined;
            if (
              !followRef.current &&
              streamingRef.current &&
              node &&
              typeof node.scrollTop === 'number' &&
              offsetUntouched(node.scrollTop, atGrowth)
            ) {
              node.scrollTop = atGrowth + deltaH;
            }
          });
        } else {
          // 原生 ScrollView 无可见位置锚定（offset 不会自变），直接补偿
          scrollTo(atGrowth + deltaH);
        }
      },
      [scrollTo],
    );

    // 发送消息等主动动作：立即回底并恢复跟随（动画中间态不可靠，用瞬时滚动）
    useImperativeHandle(
      ref,
      () => ({
        revealBottom: () => {
          followRef.current = true;
          scrollTo(0);
        },
        scrollToMessage: (id: string) => {
          const index = invertedItems.findIndex(it => it.id === id);
          if (index < 0) {
            return;
          }
          // 跳到历史位置后不能被流式钉底拉回；距底超阈值后 onScroll 自然维持 false
          followRef.current = false;
          // 瞬时定位：长距离动画晃眼且启动期易被布局变化打断（微信查找同款直接跳）
          scrollRetryRef.current = 0;
          listRef.current?.scrollToIndex({
            index,
            animated: false,
            viewPosition: 0.5,
          });
        },
      }),
      [scrollTo, invertedItems],
    );

  const renderItem = useCallback(
    ({item}: {item: TimelineItem}) => {
      const body = (() => {
        switch (item.kind) {
          case 'user':
            return (
              <View style={styles.userCol}>
                {item.images && item.images.length > 0 ? (
                  <View style={styles.userImages}>
                    {item.images.map((img, i) => (
                      <ChatImage key={i} image={img} />
                    ))}
                  </View>
                ) : null}
                {item.files?.map((f, i) => (
                  <View key={i} style={styles.userFile}>
                    <FileRefCard file={f} isUser />
                  </View>
                ))}
                {item.text ? (
                  <View style={styles.userBubbleWrap}>
                    <Bubble text={item.text} isUser />
                  </View>
                ) : null}
              </View>
            );
          case 'system':
            return (
              <View
                style={[
                  styles.systemBar,
                  item.eventKind === 'error' ? styles.systemBarError : null,
                ]}>
                <Text
                  style={[
                    styles.systemText,
                    item.eventKind === 'error' ? styles.systemTextError : null,
                  ]}>
                  {item.text}
                </Text>
              </View>
            );
          case 'approval':
            return (
              <ApprovalCard
                card={item}
                sessionId={sessionId}
                onRespond={(rid, choice) => respondApproval(sessionId, rid, choice)}
              />
            );
          case 'clarify':
            return (
              <ClarifyCard
                card={item}
                onSubmit={(rid, answers) =>
                  submitClarify(sessionId, rid, answers)
                }
              />
            );
          case 'assistant':
            return (
              <AssistantRow
                msg={item}
                showDetail={showDetail}
                onSelectText={onSelectText}
              />
            );
          default:
            return null;
        }
      })();
      // 聊天记录查找的当前命中项：消息整体 accent 描边（不动各消息组件内部，
      // 避开原生/web 两套 markdown 渲染实现）
      if (body !== null && item.id === highlightMessageId) {
        return <View style={styles.hitHighlight}>{body}</View>;
      }
      return body;
    },
    [
      onSelectText,
      respondApproval,
      submitClarify,
      sessionId,
      showDetail,
      highlightMessageId,
    ],
  );

  return (
    <View style={styles.listWrap}>
      <FlatList
        ref={listRef}
        data={invertedItems}
        keyExtractor={it => it.id}
        renderItem={renderItem}
        inverted
        contentContainerStyle={[
          styles.listContent,
          // 内容不足一屏时视觉顶部对齐（inverted 会垂直翻转容器，
          // flex-end 对应容器底部即视觉顶部；超过一屏时无影响）
          styles.listContentTop,
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={32}
        /* 首次上滚时批量首挂载重型消息 cell，批次小一点摊薄单帧成本，
         * 也让 contentSize 阶梯更小；windowSize 保持默认（已浏览区域保持
         * 挂载，二次滚动零挂载才平滑） */
        maxToRenderPerBatch={6}
        /* scrollToMessage 跳向未测量区域时索引会失败：先按平均帧高估算定位
         * （减半个视口近似 viewPosition 0.5），等批次渲染把目标 cell 测量出来
         * 后重试精确索引；限次防估算/重试死循环 */
        onScrollToIndexFailed={info => {
          const viewport = scroll.viewport || 600;
          const estimated = Math.max(
            0,
            info.index * info.averageItemLength - viewport / 2,
          );
          scrollTo(estimated);
          if (scrollRetryRef.current >= 8) {
            return;
          }
          scrollRetryRef.current += 1;
          setTimeout(() => {
            listRef.current?.scrollToIndex({
              index: info.index,
              animated: false,
              viewPosition: 0.5,
            });
          }, 120);
        }}
        onScroll={e => {
          // 合成事件是池化的，必须同步取出值，不能塞进 setState updater
          const offset = e.nativeEvent.contentOffset.y;
          lastOffsetRef.current = offset;
          lastScrollAtRef.current = Date.now();
          followRef.current = isAtBottom(offset);
          setScroll(s => (s.offset === offset ? s : {...s, offset}));
        }}
        onContentSizeChange={(_w, h) => {
          const delta = h - lastContentRef.current;
          lastContentRef.current = h;
          setScroll(s => (s.content === h ? s : {...s, content: h}));
          if (delta !== 0) {
            handleContentGrowth(delta);
          }
        }}
        onLayout={e => {
          const viewport = e.nativeEvent.layout.height;
          setScroll(s => (s.viewport === viewport ? s : {...s, viewport}));
        }}
      />
      <ChatScrollbar
        offset={scroll.offset}
        contentHeight={scroll.content}
        viewportHeight={scroll.viewport}
        onScrollTo={scrollTo}
      />
      {/* inverted 列表 offset 即距底部的距离；超过半屏显示回到底部按钮 */}
      {scroll.viewport > 0 && scroll.offset > scroll.viewport * 0.5 ? (
        <TouchableOpacity
          style={styles.jumpBtn}
          activeOpacity={0.85}
          onPress={() => {
            // 显式置位：动画中间态 offset 会先越过阈值把跟随翻成 false
            followRef.current = true;
            scrollTo(0, true);
          }}>
          <Text style={styles.jumpText}>{t('chat.jumpToBottom')}</Text>
        </TouchableOpacity>
      ) : null}
      {/* 斜杠补全浮层挂点：贴列表容器底部（即输入框正上方） */}
      {slashOverlay}
    </View>
  );
  },
);

/** 思考块是否正处流式接收中：delta 只追加到 blocks 末位的同类块，
 * 故「正在增长的思考块」必然是末位元素（按引用比较，免受过滤影响）。 */
function isLiveThinking(msg: AssistantMsg, block: AssistantBlock): boolean {
  return msg.streaming && msg.blocks[msg.blocks.length - 1] === block;
}

/** 助手消息列：无头像占位，块列整宽（文本气泡/思考/工具/错误）。 */
const AssistantRow = React.memo(function AssistantRow({
  msg,
  showDetail,
  onSelectText,
}: {
  msg: AssistantMsg;
  showDetail: boolean;
  onSelectText?: (text: string) => void;
}) {
  // showDetail=false 时隐藏工具调用/思考/推理等非对话块
  const blocks = showDetail
    ? msg.blocks
    : msg.blocks.filter(
        b =>
          b.type !== 'tool' && b.type !== 'thinking' && b.type !== 'reasoning',
      );
  return (
    <View style={styles.assistantCol}>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'text':
            return (
              <Bubble
                key={i}
                text={b.text}
                isUser={false}
                onSelectText={onSelectText}
              />
            );
          case 'thinking':
            return (
              <ThinkingBlock
                key={i}
                text={b.text}
                variant="thinking"
                live={isLiveThinking(msg, b)}
              />
            );
          case 'reasoning':
            return (
              <ThinkingBlock
                key={i}
                text={b.text}
                variant="reasoning"
                live={isLiveThinking(msg, b)}
              />
            );
          case 'tool':
            return <ToolCallCard key={b.tool.toolId} tool={b.tool} />;
          case 'image':
            return <ChatImage key={i} image={b.image} />;
          case 'file':
            return <FileRefCard key={i} file={b.file} />;
          case 'error':
            return (
              <View key={i} style={styles.errorBar}>
                <Text style={styles.errorText}>{b.text}</Text>
              </View>
            );
          default:
            return null;
        }
      })}
      {msg.streaming ? (
        <View style={styles.cursorWrap}>
          <StreamCursor />
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  listWrap: {flex: 1},
  listContent: {paddingVertical: 10},
  listContentTop: {flexGrow: 1, justifyContent: 'flex-end'},
  jumpBtn: {
    position: 'absolute',
    right: 14,
    bottom: 14,
    backgroundColor: Colors.card,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: {width: 0, height: 2},
    elevation: 3,
  },
  jumpText: {fontSize: 13, color: Colors.accentDark, fontWeight: '600'},
  /** 聊天记录查找的当前命中消息描边（包在最外层，不侵入消息组件内部） */
  hitHighlight: {
    borderWidth: 2,
    borderColor: Colors.accent,
    borderRadius: 10,
  },
  systemBar: {
    alignSelf: 'center',
    maxWidth: '86%',
    marginVertical: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: '#ECEDF2',
  },
  systemBarError: {backgroundColor: Colors.dangerBg},
  systemText: {fontSize: 12, color: Colors.textSecondary},
  systemTextError: {color: Colors.danger},
  assistantCol: {paddingHorizontal: 12, marginVertical: 3},
  cursorWrap: {paddingHorizontal: 4, paddingTop: 2},
  errorBar: {
    backgroundColor: Colors.dangerBg,
    borderRadius: 8,
    padding: 8,
    marginTop: 4,
  },
  errorText: {color: Colors.danger, fontSize: 13},
  userCol: {alignItems: 'flex-end'},
  userImages: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    paddingHorizontal: 12,
    gap: 6,
  },
  userFile: {paddingHorizontal: 12, alignSelf: 'flex-end'},
  /** user 文本气泡的 12px 内边距（Bubble 自身不带水平边距） */
  userBubbleWrap: {paddingHorizontal: 12, alignSelf: 'flex-end'},
});
