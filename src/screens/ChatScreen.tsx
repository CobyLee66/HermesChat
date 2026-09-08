import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  BackHandler,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';

import {ChatHeaderTitle} from '../components/ChatHeaderTitle';
import {SlashSuggest} from '../components/SlashSuggest';
import {Colors} from '../components/theme';
import {ChatInputBar} from '../panels/ChatInputBar';
import {ChatOverlays, type ChatOverlaysState} from '../panels/ChatOverlays';
import {
  TimelineView,
  type TimelineViewHandle,
} from '../panels/TimelineView';
import {useChatComposer} from '../panels/useChatComposer';
import {useChatStore} from '../store/chat';
import {useConnectionStore} from '../store/connection';
import type {RootStackParamList} from '../navigation/types';
import {copyText} from '../utils/clipboard';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Chat'>;
type Rt = RouteProp<RootStackParamList, 'Chat'>;

export function ChatScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const {sessionId, profile, title} = route.params;

  const chat = useChatStore(s => s.bySession[sessionId]);
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

  // 输入框状态 + 斜杠补全 + 发送分流（与桌面 ChatPane 共用）；
  // 发送即回底恢复跟随（上滑浏览时发消息也能立刻看到回复）
  const timelineRef = useRef<TimelineViewHandle>(null);
  const onAfterSend = useCallback(() => {
    timelineRef.current?.revealBottom();
  }, []);
  const {input, setInput, slash, onInputKeyPress, onSend} = useChatComposer(
    sessionId,
    openModelPicker,
    onAfterSend,
  );

  /** 是否显示工具调用/思考/推理等非对话内容（顶栏菜单切换） */
  const [showDetail, setShowDetail] = useState(true);
  /** 文本选择层内容（助手气泡长按弹出；不用 Modal，见 Bubble 注释） */
  const [selectText, setSelectText] = useState<string | null>(null);
  /** 「复制全部」点击后的已复制反馈（短暂显示后自动还原） */
  const [copied, setCopied] = useState(false);

  const openTextSelect = useCallback((text: string) => setSelectText(text), []);

  const closeTextSelect = useCallback(() => {
    setSelectText(null);
    setCopied(false);
  }, []);

  // 选择层打开时硬件返回键负责关闭（无 Modal 时默认会退出页面）
  useEffect(() => {
    if (!selectText) {
      return;
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeTextSelect();
      return true;
    });
    return () => sub.remove();
  }, [selectText, closeTextSelect]);

  // 已复制反馈 1.5s 后自动还原
  useEffect(() => {
    if (!copied) {
      return;
    }
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const onCopyAll = useCallback(() => {
    if (selectText !== null) {
      copyText(selectText).then(
        () => setCopied(true),
        () => {},
      );
    }
  }, [selectText]);

  // 补全浮层打开时硬件返回键先关补全（无 Modal 时默认会退出页面）
  const {open: slashOpen, close: closeSlash} = slash;
  useEffect(() => {
    if (!slashOpen) {
      return;
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeSlash();
      return true;
    });
    return () => sub.remove();
  }, [slashOpen, closeSlash]);

  const foreign = chat?.foreign ?? null;
  const forking = chat?.forking ?? false;
  const migratedTo = chat?.migratedTo;

  useEffect(() => {
    navigation.setOptions({
      // title 置空：原生字符串标题为空时 react-native-screens 会把安卓
      // toolbar 的 72dp 标题缩进清零，自定义 headerTitle 才能占满中间
      title: '',
      headerTitleAlign: 'center',
      headerTitle: () => (
        <ChatHeaderTitle sessionId={sessionId} title={title || '会话'} />
      ),
      headerRight: () => (
        <TouchableOpacity
          onPress={() => setOverlays(s => ({...s, menuVisible: true}))}
          hitSlop={12}>
          <Text style={styles.menuIcon}>⋯</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation, sessionId, title]);

  // foreign 会话首次发送完成派生：切到派生出的 own 会话（事件流都走新 sid）
  useEffect(() => {
    if (migratedTo) {
      navigation.replace('Chat', {sessionId: migratedTo, profile, title});
    }
  }, [migratedTo, navigation, profile, title]);

  return (
    <View style={styles.container}>
      {connState === 'reconnecting' ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>连接已断开，正在重连…</Text>
        </View>
      ) : null}
      {chat?.resumeFailed ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>会话已被服务端回收，请返回重新进入</Text>
        </View>
      ) : null}
      {foreign ? (
        <View style={styles.bannerGray}>
          <Text style={styles.bannerGrayText}>
            QQ 来源会话 · 发送消息将派生到当前 profile 继续
          </Text>
        </View>
      ) : null}
      {forking ? (
        <View style={styles.bannerGray}>
          <Text style={styles.bannerGrayText}>正在派生到当前 profile…</Text>
        </View>
      ) : null}
      <TimelineView
        ref={timelineRef}
        sessionId={sessionId}
        showDetail={showDetail}
        onSelectText={openTextSelect}
        slashOverlay={
          slash.open ? (
            <SlashSuggestOverlay slash={slash} onApply={setInput} />
          ) : null
        }
      />
      <ChatInputBar
        sessionId={sessionId}
        profile={profile}
        input={input}
        onInputChange={setInput}
        onInputKeyPress={onInputKeyPress}
        onSend={onSend}
        attachPanelOpen={attachPanelOpen}
        onAttachPanelChange={setAttachPanelOpen}
      />

      <ChatOverlays
        sessionId={sessionId}
        profile={profile}
        state={overlays}
        setState={patch => setOverlays(s => ({...s, ...patch}))}
        showDetail={showDetail}
        onToggleShowDetail={() => setShowDetail(v => !v)}
        onSessionDeleted={() => navigation.goBack()}
      />

      {/* 文本选择层：直接在屏幕窗口树里渲染（Modal 对话框里可编辑 EditText
          的系统选择菜单会被立刻关掉，普通窗口才稳定），尽量占满可用高度 */}
      {selectText !== null ? (
        <View style={styles.selectOverlay}>
          <View style={styles.selectCard}>
            <TextInput
              style={styles.selectInput}
              value={selectText}
              multiline
              textAlignVertical="top"
              autoCorrect={false}
              spellCheck={false}
              showSoftInputOnFocus={false}
            />
            <View style={styles.selectActions}>
              <TouchableOpacity
                style={styles.selectCopy}
                activeOpacity={0.8}
                onPress={onCopyAll}>
                <Text style={styles.selectCopyText}>
                  {copied ? '已复制 ✓' : '复制全部'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.selectClose}
                activeOpacity={0.8}
                onPress={closeTextSelect}>
                <Text style={styles.selectCloseText}>关闭</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** 斜杠补全浮层（挂在 TimelineView 列表容器内的插槽）。 */
function SlashSuggestOverlay({
  slash,
  onApply,
}: {
  slash: ReturnType<typeof useChatComposer>['slash'];
  onApply: (text: string) => void;
}) {
  return (
    <SlashSuggest
      items={slash.items}
      selected={slash.selected}
      onPick={i => {
        const next = slash.applyAt(i);
        if (next !== null) {
          onApply(next);
        }
      }}
    />
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: Colors.bg},
  menuIcon: {fontSize: 24, color: Colors.text, paddingHorizontal: 8},
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
  /** 文本选择层：盖满整屏，白卡尽量占高，输入框 flex:1 内部滚动 */
  selectOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.35)',
    padding: 12,
    zIndex: 10,
  },
  selectCard: {
    flex: 1,
    backgroundColor: Colors.card,
    borderRadius: 12,
    padding: 12,
  },
  selectInput: {
    flex: 1,
    fontSize: 15,
    lineHeight: 22,
    color: Colors.text,
    backgroundColor: Colors.bg,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 10,
  },
  selectActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
  },
  selectCopy: {
    borderRadius: 17,
    paddingHorizontal: 24,
    paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    backgroundColor: Colors.bg,
  },
  selectCopyText: {fontSize: 14, color: Colors.text},
  selectClose: {
    borderRadius: 17,
    paddingHorizontal: 28,
    paddingVertical: 8,
    backgroundColor: Colors.accent,
  },
  selectCloseText: {fontSize: 14, color: '#FFFFFF', fontWeight: '500'},
});
