/**
 * TimelineView — 聊天时间线面板（inverted FlatList + 条目渲染 + 自绘滚动条 +
 * 回到底部 + 斜杠补全浮层挂点）。手机 ChatScreen 与桌面聊天列共用。
 *
 * 斜杠补全浮层必须挂在本面板的列表容器内（absolute 子元素渲染在父容器边界内，
 * Android 触摸命中才有保障）——通过 slashOverlay 插槽由调用方传入。
 */

import React, {useCallback, useMemo, useRef, useState} from 'react';
import {FlatList, StyleSheet, Text, TouchableOpacity, View} from 'react-native';

import {ApprovalCard} from '../components/ApprovalCard';
import {Bubble} from '../components/Bubble';
import {ChatImage} from '../components/ChatImage';
import {ChatScrollbar} from '../components/ChatScrollbar';
import {ClarifyCard} from '../components/ClarifyCard';
import {FileRefCard} from '../components/FileRefCard';
import {Colors} from '../components/theme';
import {StreamCursor, ThinkingBlock} from '../components/ThinkingBlock';
import {ToolCallCard} from '../components/ToolCallCard';
import {useChatStore} from '../store/chat';
import type {AssistantMsg, TimelineItem} from '../rpc/types';

const EMPTY_ITEMS: TimelineItem[] = [];

export function TimelineView({
  sessionId,
  showDetail,
  onSelectText,
  slashOverlay,
}: {
  sessionId: string;
  /** 是否显示工具调用/思考/推理等非对话内容 */
  showDetail: boolean;
  /** 助手气泡长按选择文本（手机端）；桌面端不传即关闭该交互 */
  onSelectText?: (text: string) => void;
  slashOverlay?: React.ReactNode;
}) {
  const chat = useChatStore(s => s.bySession[sessionId]);
  const respondApproval = useChatStore(s => s.respondApproval);
  const respondClarify = useChatStore(s => s.respondClarify);

  const items = useMemo(() => chat?.items ?? EMPTY_ITEMS, [chat?.items]);
  const invertedItems = useMemo(() => [...items].reverse(), [items]);

  /** 列表滚动状态：驱动自绘滚动条与「回到底部」按钮 */
  const [scroll, setScroll] = useState({offset: 0, content: 0, viewport: 0});
  const listRef = useRef<FlatList<TimelineItem>>(null);

  const scrollTo = useCallback((offset: number, animated = false) => {
    listRef.current?.scrollToOffset({offset, animated});
  }, []);

  const renderItem = useCallback(
    ({item}: {item: TimelineItem}) => {
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
              onAnswer={(rid, answer, qid) =>
                respondClarify(sessionId, rid, answer, qid)
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
    },
    [onSelectText, respondApproval, respondClarify, sessionId, showDetail],
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
        onScroll={e => {
          // 合成事件是池化的，必须同步取出值，不能塞进 setState updater
          const offset = e.nativeEvent.contentOffset.y;
          setScroll(s => (s.offset === offset ? s : {...s, offset}));
        }}
        onContentSizeChange={(_w, h) =>
          setScroll(s => (s.content === h ? s : {...s, content: h}))
        }
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
          onPress={() => scrollTo(0, true)}>
          <Text style={styles.jumpText}>↓ 回到底部</Text>
        </TouchableOpacity>
      ) : null}
      {/* 斜杠补全浮层挂点：贴列表容器底部（即输入框正上方） */}
      {slashOverlay}
    </View>
  );
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
            return <ThinkingBlock key={i} text={b.text} variant="thinking" />;
          case 'reasoning':
            return <ThinkingBlock key={i} text={b.text} variant="reasoning" />;
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
