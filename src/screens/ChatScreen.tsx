import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Alert,
  BackHandler,
  FlatList,
  Image,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {
  pick,
  keepLocalCopy,
  types,
  errorCodes,
  isErrorWithCode,
} from '@react-native-documents/picker';

import {ApprovalCard} from '../components/ApprovalCard';
import {Bubble} from '../components/Bubble';
import {ChatImage} from '../components/ChatImage';
import {ChatScrollbar} from '../components/ChatScrollbar';
import {ClarifyCard} from '../components/ClarifyCard';
import {FileRefCard} from '../components/FileRefCard';
import {HeaderTitleView} from '../components/HeaderTitle';
import {IconImage} from '../components/icons';
import {ModelPicker} from '../components/ModelPicker';
import {Colors} from '../components/theme';
import {StreamCursor, ThinkingBlock} from '../components/ThinkingBlock';
import {ToolCallCard} from '../components/ToolCallCard';
import {VoiceButton} from '../components/VoiceButton';
import type {AssistantMsg, TimelineItem} from '../rpc/types';
import {useChatStore} from '../store/chat';
import {useKeyboardHeight} from '../utils/useKeyboardHeight';
import {useConnectionStore} from '../store/connection';
import type {RootStackParamList} from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Chat'>;
type Rt = RouteProp<RootStackParamList, 'Chat'>;

export function ChatScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const {sessionId, profile, title} = route.params;

  const chat = useChatStore(s => s.bySession[sessionId]);
  const {
    sendPrompt,
    interrupt,
    respondApproval,
    respondClarify,
    switchModel,
    fetchModelOptions,
    attachImages,
    removeAttachment,
    attachFile,
  } = useChatStore();
  const connState = useConnectionStore(s => s.state);

  const [input, setInput] = useState('');
  const [menuVisible, setMenuVisible] = useState(false);
  const [modelPickerVisible, setModelPickerVisible] = useState(false);
  const [infoVisible, setInfoVisible] = useState(false);
  const [attachPanelOpen, setAttachPanelOpen] = useState(false);
  const [attaching, setAttaching] = useState(false);
  // 输入法高度（手动测量，替代 KeyboardAvoidingView）
  const {bottomPad} = useKeyboardHeight();
  /** web 的 textarea 默认 2 行高且无原生自动长高：文本变化时先收回单行再量
   *  scrollHeight 设高（不收回会被 clientHeight 托底，删行后高度缩不回）；
   *  原生端输入框自带长高，不能传 numberOfLines（安卓 setLines 会锁死行数） */
  const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const isWeb = Platform.OS === 'web';
  useEffect(() => {
    if (!isWeb) {
      return;
    }
    // RN-web 的 ref 即宿主 textarea；项目 tsconfig 无 DOM lib，用结构类型
    const el = inputRef.current as unknown as {
      style: {height: string};
      scrollHeight: number;
    } | null;
    if (!el) {
      return;
    }
    el.style.height = '40px'; // 单行 = 22 行高 + 18 上下 padding
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 40), 8 * 22 + 18)}px`;
  }, [isWeb, input]);
  /** 是否显示工具调用/思考/推理等非对话内容（顶栏菜单切换） */
  const [showDetail, setShowDetail] = useState(true);
  /** 列表滚动状态：驱动自绘滚动条与「回到底部」按钮 */
  const [scroll, setScroll] = useState({offset: 0, content: 0, viewport: 0});
  const listRef = useRef<FlatList<TimelineItem>>(null);
  /** 文本选择层内容（助手气泡长按弹出；不用 Modal，见 Bubble 注释） */
  const [selectText, setSelectText] = useState<string | null>(null);

  // 选择层打开时硬件返回键负责关闭（无 Modal 时默认会退出页面）
  useEffect(() => {
    if (!selectText) {
      return;
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setSelectText(null);
      return true;
    });
    return () => sub.remove();
  }, [selectText]);

  const openTextSelect = useCallback((text: string) => setSelectText(text), []);

  const items = useMemo(() => chat?.items ?? [], [chat?.items]);
  const invertedItems = useMemo(() => [...items].reverse(), [items]);
  const busy = chat?.busy ?? false;
  const info = chat?.info ?? null;
  const status = chat?.status ?? null;
  const foreign = chat?.foreign ?? null;
  const forking = chat?.forking ?? false;
  const migratedTo = chat?.migratedTo;
  const pending = useMemo(
    () => chat?.pendingAttachments ?? [],
    [chat?.pendingAttachments],
  );

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
        <TouchableOpacity onPress={() => setMenuVisible(true)} hitSlop={12}>
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

  const onSend = useCallback(() => {
    const text = input;
    setInput('');
    sendPrompt(sessionId, text);
  }, [input, sendPrompt, sessionId]);

  /** 附件面板：相册图片（多选 → 压缩 → image.attach_bytes → 待发横条）。 */
  const onPickImages = useCallback(async () => {
    try {
      const results = await pick({
        type: [types.images],
        allowMultiSelection: true,
      });
      if (!results || results.length === 0) {
        return;
      }
      setAttaching(true);
      // content:// URI 先落地到沙盒，RNFS/image-resizer 才能读
      const files: {uri: string; name?: string | null}[] = [];
      let idx = 0;
      for (const r of results) {
        idx += 1;
        const [copy] = await keepLocalCopy({
          files: [
            {uri: r.uri, fileName: r.name ?? `image_${Date.now()}_${idx}.jpg`},
          ],
          destination: 'cachesDirectory',
        });
        if (copy.status === 'success') {
          files.push({uri: copy.localUri, name: r.name});
        }
      }
      if (files.length > 0) {
        await attachImages(sessionId, files);
      }
      setAttachPanelOpen(false);
    } catch (e) {
      if (isErrorWithCode(e) && e.code === errorCodes.OPERATION_CANCELED) {
        return;
      }
      Alert.alert('选择图片失败', e instanceof Error ? e.message : String(e));
    } finally {
      setAttaching(false);
    }
  }, [attachImages, sessionId]);

  /** 附件面板：文件（单选 → file.attach → @file: 引用追加到输入框）。 */
  const onPickFile = useCallback(async () => {
    try {
      const [res] = await pick({type: [types.allFiles]});
      if (!res) {
        return;
      }
      setAttaching(true);
      const [copy] = await keepLocalCopy({
        files: [{uri: res.uri, fileName: res.name ?? 'file'}],
        destination: 'cachesDirectory',
      });
      if (copy.status !== 'success') {
        throw new Error(copy.copyError);
      }
      const refText = await attachFile(sessionId, {
        uri: copy.localUri,
        name: res.name,
        mimeType: res.type,
      });
      if (refText) {
        setInput(v => {
          const base = v.trimEnd();
          return base ? `${base} ${refText}` : refText;
        });
      }
      setAttachPanelOpen(false);
    } catch (e) {
      if (isErrorWithCode(e) && e.code === errorCodes.OPERATION_CANCELED) {
        return;
      }
      Alert.alert('添加文件失败', e instanceof Error ? e.message : String(e));
    } finally {
      setAttaching(false);
    }
  }, [attachFile, sessionId]);

  /** 语音识别文本：追加到输入框末尾（可再编辑）。 */
  const onVoiceText = useCallback((text: string) => {
    setInput(v => {
      const base = v.trimEnd();
      return base ? `${base} ${text}` : text;
    });
    setAttachPanelOpen(false);
  }, []);

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
              onSelectText={openTextSelect}
            />
          );
        default:
          return null;
      }
    },
    [openTextSelect, respondApproval, respondClarify, sessionId, showDetail],
  );

  const usage = info?.usage;
  // total：本 gateway 进程累计 token（resume 历史会话后从 0 重计，服务端口径）
  const totalTokens = usage?.total ?? usage?.total_tokens;
  // context_*：模型上下文窗口占用，本进程至少跑过一轮后才出现
  const contextText =
    typeof usage?.context_max === 'number' && usage.context_max > 0
      ? `${usage?.context_used ?? 0} / ${usage.context_max}${
          typeof usage?.context_percent === 'number'
            ? `（${usage.context_percent}%）`
            : ''
        }`
      : null;

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
      </View>
      {/* 底部操作区整体包一层：白底 + 底部安全区/输入法高度垫高 */}
      <View style={[styles.bottomBar, {paddingBottom: bottomPad}]}>
        {status && busy ? (
          <View style={styles.statusBar}>
            <Text style={styles.statusText} numberOfLines={1}>
              {status.text}
            </Text>
          </View>
        ) : null}
        {pending.length > 0 ? (
          <ScrollView
            horizontal
            style={styles.pendingStrip}
            contentContainerStyle={styles.pendingStripContent}
            keyboardShouldPersistTaps="handled">
            {pending.map(a => (
              <View key={a.path} style={styles.pendingItem}>
                <Image source={{uri: a.localUri}} style={styles.pendingThumb} />
                <TouchableOpacity
                  style={styles.pendingRemove}
                  hitSlop={8}
                  onPress={() => removeAttachment(sessionId, a.path)}>
                  <Text style={styles.pendingRemoveText}>×</Text>
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
        ) : null}
        <View style={styles.inputBar}>
        <TouchableOpacity
          style={styles.plusBtn}
          onPress={() => setAttachPanelOpen(v => !v)}
          disabled={connState !== 'ready'}
          activeOpacity={0.7}
          hitSlop={6}
          accessibilityLabel={attachPanelOpen ? '收起附件面板' : '打开附件面板'}>
          <IconImage
            name={attachPanelOpen ? 'minus' : 'plus'}
            size={20}
            color={Colors.iconStrong}
          />
        </TouchableOpacity>
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="发消息…"
          placeholderTextColor={Colors.textSecondary}
          multiline
          editable={connState === 'ready'}
        />
        {busy ? (
          <TouchableOpacity
            style={styles.interruptBtn}
            onPress={() => interrupt(sessionId)}
            activeOpacity={0.8}>
            <Text style={styles.interruptText}>中断</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[
              styles.sendBtn,
              ((!input.trim() && pending.length === 0) ||
                connState !== 'ready') &&
                styles.sendBtnDisabled,
            ]}
            disabled={
              (!input.trim() && pending.length === 0) || connState !== 'ready'
            }
            onPress={onSend}
            activeOpacity={0.8}>
            <Text style={styles.sendText}>发送</Text>
          </TouchableOpacity>
        )}
      </View>
      {attachPanelOpen ? (
        <View style={styles.attachPanel}>
          <TouchableOpacity
            style={styles.attachTile}
            onPress={onPickImages}
            disabled={attaching}
            activeOpacity={0.7}
            accessibilityLabel="发送图片">
            <IconImage name="photo" size={26} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.attachTile}
            onPress={onPickFile}
            disabled={attaching}
            activeOpacity={0.7}
            accessibilityLabel="发送文件">
            <IconImage name="paperclip" size={26} />
          </TouchableOpacity>
          <VoiceButton profile={profile} onText={onVoiceText} />
        </View>
      ) : null}
      {attaching ? (
        <View style={styles.attachingBar}>
          <Text style={styles.attachingText}>附件上传中…</Text>
        </View>
      ) : null}
      </View>

      {/* 顶栏菜单 */}
      <Modal
        visible={menuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuVisible(false)}>
        <TouchableOpacity
          style={styles.menuBackdrop}
          activeOpacity={1}
          onPress={() => setMenuVisible(false)}>
          <View style={styles.menu}>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setMenuVisible(false);
                setModelPickerVisible(true);
              }}>
              <Text style={styles.menuText}>切换模型</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setMenuVisible(false);
                setInfoVisible(true);
              }}>
              <Text style={styles.menuText}>会话信息</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setMenuVisible(false);
                setShowDetail(v => !v);
              }}>
              <Text style={styles.menuText}>
                {showDetail ? '隐藏工具与思考' : '显示工具与思考'}
              </Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <ModelPicker
        visible={modelPickerVisible}
        onClose={() => setModelPickerVisible(false)}
        load={() => fetchModelOptions(sessionId)}
        onPick={(model, provider) => {
          switchModel(sessionId, model, provider).catch(e =>
            Alert.alert('切换失败', e instanceof Error ? e.message : String(e)),
          );
        }}
      />

      {/* 会话信息弹层（数据来自 session.info 事件/create-resume 结果） */}
      <Modal
        visible={infoVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setInfoVisible(false)}>
        <TouchableOpacity
          style={styles.menuBackdrop}
          activeOpacity={1}
          onPress={() => setInfoVisible(false)}>
          <View style={styles.infoCard}>
            <Text style={styles.infoTitle}>会话信息</Text>
            <InfoRow label="模型" value={info?.model || '未知'} />
            <InfoRow label="供应商" value={info?.provider || '未知'} />
            <InfoRow
              label="Token 用量"
              value={
                totalTokens !== undefined
                  ? `${totalTokens}（本次连接累计）`
                  : '未知'
              }
            />
            {contextText ? <InfoRow label="上下文窗口" value={contextText} /> : null}
            <InfoRow label="工作目录" value={info?.cwd || '未知'} />
            <InfoRow label="分支" value={info?.branch || '—'} />
            <InfoRow label="Profile" value={info?.profile_name || profile} />
          </View>
        </TouchableOpacity>
      </Modal>

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
            <TouchableOpacity
              style={styles.selectClose}
              activeOpacity={0.8}
              onPress={() => setSelectText(null)}>
              <Text style={styles.selectCloseText}>关闭</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** token 数简写：999 → 999，1234 → 1.2k，45230 → 45.2k，200000 → 200k */
function formatTokens(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  const k = n / 1000;
  const v = k >= 100 ? Math.round(k) : Math.round(k * 10) / 10;
  return `${v}k`;
}

/** 顶栏标题：会话标题 + 模型/上下文小字副标题（订阅 chat store，随 usage 自动刷新） */
const ChatHeaderTitle = React.memo(function ChatHeaderTitle({
  sessionId,
  title,
}: {
  sessionId: string;
  title: string;
}) {
  const info = useChatStore(s => s.bySession[sessionId]?.info);
  const used = info?.usage?.context_used;
  const max = info?.usage?.context_max;
  const subtitle = info?.model
    ? typeof used === 'number' && typeof max === 'number' && max > 0
      ? `${info.model} · ${formatTokens(used)}/${formatTokens(max)}`
      : info.model
    : null;
  return <HeaderTitleView title={title} subtitle={subtitle} />;
});

function InfoRow({label, value}: {label: string; value: string}) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue} selectable numberOfLines={2}>
        {value}
      </Text>
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
  onSelectText: (text: string) => void;
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
  container: {flex: 1, backgroundColor: Colors.bg},
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
  statusBar: {
    paddingHorizontal: 14,
    paddingVertical: 4,
    backgroundColor: '#ECEDF2',
  },
  statusText: {fontSize: 12, color: Colors.textSecondary},
  /** 底部操作区（状态条/附件横条/输入栏/附件面板）的统一底色与安全区承载 */
  bottomBar: {backgroundColor: Colors.card},
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: Colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  plusBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    // 填充 + 可见描边：之前只有发丝描边、无填充，在白卡片上几乎看不见圆圈
    backgroundColor: Colors.fill,
    borderWidth: 1,
    borderColor: Colors.fillBorder,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  pendingStrip: {
    backgroundColor: Colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  pendingStripContent: {paddingHorizontal: 10, paddingVertical: 8},
  pendingItem: {marginRight: 8},
  pendingThumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: Colors.border,
  },
  pendingRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingRemoveText: {color: '#FFF', fontSize: 12, lineHeight: 14},
  attachPanel: {
    flexDirection: 'row',
    backgroundColor: Colors.card,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  /** 面板三格统一 56 高（与 VoiceButton 磁贴一致），纯图标无文字 */
  attachTile: {alignItems: 'center', justifyContent: 'center', width: 88, height: 56},
  attachingBar: {
    backgroundColor: Colors.card,
    paddingVertical: 4,
    alignItems: 'center',
  },
  attachingText: {fontSize: 12, color: Colors.textSecondary},
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
  input: {
    flex: 1,
    minHeight: 38,
    // 多行自动撑高，上限 8 行（8×22 行高 + 上下 padding）
    maxHeight: 8 * 22 + 18,
    lineHeight: 22,
    backgroundColor: Colors.bg,
    borderRadius: 19,
    paddingHorizontal: 14,
    paddingVertical: 9,
    fontSize: 16,
    color: Colors.text,
  },
  sendBtn: {
    marginLeft: 8,
    backgroundColor: Colors.accent,
    borderRadius: 19,
    paddingHorizontal: 18,
    paddingVertical: 9,
    justifyContent: 'center',
  },
  sendBtnDisabled: {opacity: 0.4},
  sendText: {color: '#FFF', fontSize: 15, fontWeight: '600'},
  interruptBtn: {
    marginLeft: 8,
    backgroundColor: '#FFF',
    borderWidth: 1,
    borderColor: Colors.danger,
    borderRadius: 19,
    paddingHorizontal: 16,
    paddingVertical: 9,
    justifyContent: 'center',
  },
  interruptText: {color: Colors.danger, fontSize: 15, fontWeight: '600'},
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  menu: {
    backgroundColor: Colors.card,
    borderRadius: 12,
    minWidth: 200,
    overflow: 'hidden',
  },
  menuItem: {paddingVertical: 14, paddingHorizontal: 20},
  menuText: {fontSize: 15, color: Colors.text},
  infoCard: {
    backgroundColor: Colors.card,
    borderRadius: 12,
    padding: 18,
    minWidth: 280,
    maxWidth: '85%',
  },
  infoTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: Colors.text,
    marginBottom: 10,
  },
  infoRow: {flexDirection: 'row', marginVertical: 3},
  infoLabel: {width: 80, fontSize: 13, color: Colors.textSecondary},
  infoValue: {flex: 1, fontSize: 13, color: Colors.text},
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
  selectClose: {
    alignSelf: 'center',
    borderRadius: 17,
    paddingHorizontal: 28,
    paddingVertical: 8,
    backgroundColor: Colors.accent,
  },
  selectCloseText: {fontSize: 14, color: '#FFFFFF', fontWeight: '500'},
});
