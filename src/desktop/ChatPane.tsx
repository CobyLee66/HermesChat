/**
 * ChatPane — 桌面聊天列。与手机 ChatScreen 共享 TimelineView/ChatInputBar/
 * ChatOverlays/useChatComposer，差异：无导航栈（头部自绘 + narrow 返回键）、
 * 不挂长按选择层（桌面文本用系统选择/复制，M4 打磨）。
 */

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';

import {ChatHeaderTitle} from '../components/ChatHeaderTitle';
import {SearchBar} from '../components/SearchBar';
import {SlashSuggest} from '../components/SlashSuggest';
import {Colors} from '../components/theme';
import {
  desktopPickFile,
  desktopPickImages,
} from './desktopMedia';
import {ChatInputBar} from '../panels/ChatInputBar';
import {ChatOverlays, type ChatOverlaysState} from '../panels/ChatOverlays';
import {
  TimelineView,
  type TimelineViewHandle,
} from '../panels/TimelineView';
import {useChatComposer} from '../panels/useChatComposer';
import {useChatSearch} from '../panels/useChatSearch';
import {useChatStore} from '../store/chat';
import {useConnectionStore} from '../store/connection';
import {alertError} from '../utils/alert';
import {openChat, useDesktopUiStore, type DesktopChatRef} from './desktopUiStore';

// 无 DOM lib：粘贴/拖拽相关结构类型
interface WebFileLike {
  name?: string;
  type?: string;
}
interface WebDataTransfer {
  items?: {
    length: number;
    [index: number]: {kind: string; type: string; getAsFile: () => WebFileLike | null};
  };
  files?: {
    length: number;
    [index: number]: WebFileLike;
  };
}
interface WebDomEvent {
  preventDefault?: () => void;
  clipboardData?: WebDataTransfer;
  dataTransfer?: WebDataTransfer;
}

function fileToDataUrl(file: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const Ctor = (globalThis as {FileReader?: new () => {
      readAsDataURL: (b: unknown) => void;
      onload: (() => void) | null;
      onerror: (() => void) | null;
      result: string | null;
    }}).FileReader;
    if (!Ctor) {
      reject(new Error('当前环境不支持读取文件'));
      return;
    }
    const reader = new Ctor();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        resolve(result);
      } else {
        reject(new Error('读取文件失败'));
      }
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

export function ChatPane({
  chat,
  narrow,
}: {
  chat: DesktopChatRef;
  /** narrow 单列：头部带「返回」 */
  narrow?: boolean;
}) {
  const chatState = useChatStore(s => s.bySession[chat.sessionId]);
  const connState = useConnectionStore(s => s.state);

  const [overlays, setOverlays] = useState<ChatOverlaysState>({
    menuVisible: false,
    modelPickerVisible: false,
    infoVisible: false,
  });
  const [attachPanelOpen, setAttachPanelOpen] = useState(false);
  const openModelPicker = useCallback(() => {
    setOverlays(s => ({...s, modelPickerVisible: true}));
  }, []);

  // 发送即回底恢复跟随（上滑浏览时发消息也能立刻看到回复）
  const timelineRef = useRef<TimelineViewHandle>(null);
  const onAfterSend = useCallback(() => {
    timelineRef.current?.revealBottom();
  }, []);
  const {input, setInput, slash, onInputKeyPress, onSend} = useChatComposer(
    chat.sessionId,
    openModelPicker,
    onAfterSend,
  );

  // 聊天记录查找：顶部搜索栏 + ↑/↓ 循环跳转命中消息（TimelineView 内滚动定位）
  const search = useChatSearch(chat.sessionId, timelineRef);
  // effect 依赖用解构后的稳定引用（hide 是空依赖 useCallback）
  const {visible: searchVisible, hide: hideSearch} = search;

  /** 是否显示工具调用/思考/推理等非对话内容（菜单切换） */
  const [showDetail, setShowDetail] = useState(true);

  const attachImages = useChatStore(s => s.attachImages);
  const attachFile = useChatStore(s => s.attachFile);
  const connReady = connState === 'ready';

  // 输入框当前值 ref（window 级事件回调里拿到最新值做追加）
  const inputRef = useRef('');
  inputRef.current = input;

  const close = useDesktopUiStore(s => s.closeChat);

  /** 桌面附件来源：系统文件对话框（读字节由主进程完成） */
  const pickers = useMemo(
    () => ({pickImages: desktopPickImages, pickFile: desktopPickFile}),
    [],
  );

  // Esc 关闭：搜索栏 > 菜单 > 模型面板 > 会话信息
  useEffect(() => {
    const onKey = (ev: {key?: string}) => {
      if (ev.key !== 'Escape') {
        return;
      }
      if (searchVisible) {
        hideSearch();
        return;
      }
      setOverlays(s => {
        if (s.menuVisible) {
          return {...s, menuVisible: false};
        }
        if (s.modelPickerVisible) {
          return {...s, modelPickerVisible: false};
        }
        if (s.infoVisible) {
          return {...s, infoVisible: false};
        }
        return s;
      });
    };
    (globalThis as {window?: {addEventListener?: (t: string, l: unknown) => void; removeEventListener?: (t: string, l: unknown) => void}})
      .window?.addEventListener?.('keydown', onKey);
    return () => {
      (globalThis as {window?: {removeEventListener?: (t: string, l: unknown) => void}})
        .window?.removeEventListener?.('keydown', onKey);
    };
  }, [searchVisible, hideSearch]);

  // Ctrl+V 粘贴图片 → 待发附件
  useEffect(() => {
    if (!connReady) {
      return;
    }
    const onPaste = (ev: WebDomEvent) => {
      const items = ev.clipboardData?.items;
      if (!items) {
        return;
      }
      const images: Promise<string>[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) {
            images.push(fileToDataUrl(f));
          }
        }
      }
      if (images.length === 0) {
        return;
      }
      ev.preventDefault?.();
      void Promise.all(images)
        .then(urls =>
          attachImages(
            chat.sessionId,
            urls.map((uri, i) => ({
              uri,
              name: `粘贴图片_${Date.now()}_${i + 1}.png`,
            })),
          ),
        )
        .catch(e =>
          alertError('粘贴图片失败', e instanceof Error ? e.message : String(e)),
        );
    };
    const win = (globalThis as {
      window?: {addEventListener?: (t: string, l: unknown) => void; removeEventListener?: (t: string, l: unknown) => void};
    }).window;
    win?.addEventListener?.('paste', onPaste);
    return () => {
      win?.removeEventListener?.('paste', onPaste);
    };
  }, [attachImages, chat.sessionId, connReady]);

  // 拖拽文件进窗口：图片 → 待发附件；其它文件 → @file: 引用
  useEffect(() => {
    if (!connReady) {
      return;
    }
    const onDragOver = (ev: WebDomEvent) => {
      ev.preventDefault?.();
    };
    const onDrop = (ev: WebDomEvent) => {
      const files = ev.dataTransfer?.files;
      if (!files || files.length === 0) {
        return;
      }
      ev.preventDefault?.();
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        void fileToDataUrl(f)
          .then(dataUrl => {
            if (f.type?.startsWith('image/')) {
              return attachImages(chat.sessionId, [
                {uri: dataUrl, name: f.name ?? `图片_${Date.now()}.png`},
              ]);
            }
            return attachFile(chat.sessionId, {
              uri: dataUrl,
              name: f.name,
              mimeType: f.type,
            }).then(refText => {
              if (refText) {
                const base = inputRef.current.trimEnd();
                setInput(base ? `${base} ${refText}` : refText);
              }
            });
          })
          .catch(e =>
            alertError('添加附件失败', e instanceof Error ? e.message : String(e)),
          );
      }
    };
    const win = (globalThis as {
      window?: {addEventListener?: (t: string, l: unknown) => void; removeEventListener?: (t: string, l: unknown) => void};
    }).window;
    win?.addEventListener?.('dragover', onDragOver);
    win?.addEventListener?.('drop', onDrop);
    return () => {
      win?.removeEventListener?.('dragover', onDragOver);
      win?.removeEventListener?.('drop', onDrop);
    };
  }, [attachFile, attachImages, chat.sessionId, connReady, setInput]);

  // foreign 会话首次发送完成派生：跟随切到派生出的 own 会话
  const migratedTo = chatState?.migratedTo;
  useEffect(() => {
    if (migratedTo) {
      openChat({...chat, sessionId: migratedTo});
    }
  }, [migratedTo, chat]);

  return (
    <View style={styles.container}>
      {/* 列头：返回（narrow）/ 标题+副标题 / 菜单 */}
      <View style={styles.header}>
        {narrow ? (
          <TouchableOpacity
            style={styles.backBtn}
            activeOpacity={0.7}
            onPress={close}
            hitSlop={8}>
            <Text style={styles.backText}>‹ 返回</Text>
          </TouchableOpacity>
        ) : null}
        <View style={styles.headerTitleWrap}>
          <ChatHeaderTitle sessionId={chat.sessionId} title={chat.title || '会话'} />
        </View>
        <TouchableOpacity
          style={styles.menuBtn}
          onPress={() => setOverlays(s => ({...s, menuVisible: true}))}
          hitSlop={8}>
          <Text style={styles.menuIcon}>⋯</Text>
        </TouchableOpacity>
      </View>

      {connState === 'reconnecting' ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>连接已断开，正在重连…</Text>
        </View>
      ) : null}
      {chatState?.resumeFailed ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>会话已被服务端回收，请重新选择会话</Text>
        </View>
      ) : null}
      {chatState?.foreign ? (
        <View style={styles.bannerGray}>
          <Text style={styles.bannerGrayText}>
            QQ 来源会话 · 发送消息将派生到当前 profile 继续
          </Text>
        </View>
      ) : null}
      {chatState?.forking ? (
        <View style={styles.bannerGray}>
          <Text style={styles.bannerGrayText}>正在派生到当前 profile…</Text>
        </View>
      ) : null}

      {search.visible ? (
        <SearchBar
          value={search.query}
          onChangeText={search.setQuery}
          onClose={search.hide}
          placeholder="查找聊天记录"
          total={search.total}
          activeIndex={search.activeIndex}
          onPrev={search.onPrev}
          onNext={search.onNext}
        />
      ) : null}

      <TimelineView
        ref={timelineRef}
        sessionId={chat.sessionId}
        showDetail={showDetail}
        highlightMessageId={search.highlightId}
        slashOverlay={
          slash.open ? (
            <SlashSuggest
              items={slash.items}
              selected={slash.selected}
              onPick={i => {
                const next = slash.applyAt(i);
                if (next !== null) {
                  setInput(next);
                }
              }}
            />
          ) : null
        }
      />
      <ChatInputBar
        sessionId={chat.sessionId}
        profile={chat.profile}
        input={input}
        onInputChange={setInput}
        onInputKeyPress={onInputKeyPress}
        onSend={onSend}
        attachPanelOpen={attachPanelOpen}
        onAttachPanelChange={setAttachPanelOpen}
        pickers={pickers}
        enterToSend
      />

      <ChatOverlays
        sessionId={chat.sessionId}
        profile={chat.profile}
        state={overlays}
        setState={patch => setOverlays(s => ({...s, ...patch}))}
        showDetail={showDetail}
        onToggleShowDetail={() => setShowDetail(v => !v)}
        onSessionDeleted={close}
        onOpenSearch={search.show}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: Colors.bg},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 52,
    backgroundColor: Colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
    paddingHorizontal: 8,
  },
  backBtn: {paddingHorizontal: 6, paddingVertical: 8},
  backText: {fontSize: 15, color: Colors.accent},
  headerTitleWrap: {flex: 1, alignItems: 'center'},
  menuBtn: {paddingHorizontal: 10, paddingVertical: 8},
  menuIcon: {fontSize: 24, color: Colors.text},
  banner: {
    backgroundColor: '#FFF7E8',
    paddingVertical: 6,
    alignItems: 'center',
  },
  bannerText: {fontSize: 12, color: '#FF7D00'},
  bannerGray: {
    backgroundColor: '#ECEDF2',
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  bannerGrayText: {fontSize: 12, color: Colors.textSecondary},
});
