/**
 * ChatInputBar — 聊天底部操作区面板：busy 状态条、待发附件横条、排队消息条、
 * 输入栏（+按钮 / 多行输入 / 发送 或 排队+中断纵向按钮列）、附件面板、上传中提示。
 * 手机 ChatScreen 与桌面聊天列共用。输入内容受控于父级（斜杠补全派生）。
 */

import React, {useCallback, useEffect, useMemo, useRef} from 'react';
import {
  Image,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  pick,
  keepLocalCopy,
  types,
  errorCodes,
  isErrorWithCode,
} from '@react-native-documents/picker';

import {BusyTicker} from '../components/BusyTicker';
import {IconImage} from '../components/icons';
import {Colors} from '../components/theme';
import {VoiceButton} from '../components/VoiceButton';
import {useT} from '../i18n';
import {useChatStore} from '../store/chat';
import {useConnectionStore} from '../store/connection';
import {
  queuedKeyFor,
  useQueuedPromptsStore,
  type QueuedPrompt,
} from '../store/queuedPrompts';
import {forceFlushQueued} from '../store/queuedPromptsEngine';
import {alertError} from '../utils/alert';
import {isKawaiiHint} from '../utils/busyTicker';
import {useKeyboardHeight} from '../utils/useKeyboardHeight';

/** 中断后补发队首排队消息的延迟：先让「busy 翻转」的常规排水路径赢 */
const INTERRUPT_FLUSH_DELAY_MS = 500;
/** 无排队条目的稳定空引用（禁止内联新建对象/数组，D009） */
const EMPTY_QUEUED: QueuedPrompt[] = [];

/** 附件来源注入：桌面传对话框实现，缺省用手机 documents-picker 流程。 */
export interface ChatAttachmentPickers {
  pickImages(): Promise<
    {uri: string; name?: string | null; mimeType?: string | null}[]
  >;
  pickFile(): Promise<{
    uri: string;
    name?: string | null;
    mimeType?: string | null;
  } | null>;
}

export function ChatInputBar({
  sessionId,
  profile,
  input,
  onInputChange,
  onInputKeyPress,
  onSend,
  attachPanelOpen,
  onAttachPanelChange,
  pickers,
  enterToSend,
}: {
  sessionId: string;
  profile: string;
  input: string;
  onInputChange: (v: string) => void;
  onInputKeyPress?: (e: {nativeEvent: {key: string}}) => void;
  onSend: () => void;
  attachPanelOpen: boolean;
  onAttachPanelChange: (open: boolean) => void;
  pickers?: ChatAttachmentPickers;
  /** 桌面：Enter 发送 / Shift+Enter 换行（手机不传，保持换行语义） */
  enterToSend?: boolean;
}) {
  const t = useT();
  const chat = useChatStore(s => s.bySession[sessionId]);
  // 逐个 action 选择器（引用稳定）：全 store 订阅会让输入框在流式期间
  // 每 delta 重渲染
  const interrupt = useChatStore(s => s.interrupt);
  const attachImages = useChatStore(s => s.attachImages);
  const removeAttachment = useChatStore(s => s.removeAttachment);
  const attachFile = useChatStore(s => s.attachFile);
  const connState = useConnectionStore(s => s.state);

  const [attaching, setAttaching] = React.useState(false);
  const [originalImage, setOriginalImage] = React.useState(false);

  const busy = chat?.busy ?? false;
  const status = chat?.status ?? null;
  // thinking.delta 占位：kawaii 帧由 BusyTicker 动画接管，只透传 ⏳/⚠ 等待说明
  const thinkingHint = chat?.thinkingHint ?? null;
  const pending = useMemo(
    () => chat?.pendingAttachments ?? [],
    [chat?.pendingAttachments],
  );

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

  /** 桌面 Enter 发送 / Shift+Enter 换行（IME 组合中不发送）；其余键交给
   *  斜杠补全的键盘导航。 */
  const handleKeyPress = useCallback(
    (
      e: {
        nativeEvent: {key: string; shiftKey?: boolean; isComposing?: boolean};
        preventDefault?: () => void;
      },
    ) => {
      if (
        enterToSend &&
        e.nativeEvent.key === 'Enter' &&
        !e.nativeEvent.shiftKey &&
        !e.nativeEvent.isComposing
      ) {
        e.preventDefault?.();
        onSend();
        return;
      }
      onInputKeyPress?.(e);
    },
    [enterToSend, onInputKeyPress, onSend],
  );

  /** 附件面板：同一图片入口按“原图”勾选态选择直读或压缩上传。 */
  const onPickImages = useCallback(async () => {
    try {
      setAttaching(true);
      const files = pickers ? await pickers.pickImages() : await pickImagesNative();
      if (files.length > 0) {
        await attachImages(sessionId, files, {original: originalImage});
      }
      onAttachPanelChange(false);
    } catch (e) {
      if (!pickers && isErrorWithCode(e) && e.code === errorCodes.OPERATION_CANCELED) {
        return;
      }
      alertError(t('input.pickImageFailed'), e instanceof Error ? e.message : String(e));
    } finally {
      setAttaching(false);
    }
  }, [attachImages, onAttachPanelChange, originalImage, pickers, sessionId, t]);

  /** 附件面板：文件（单选 → file.attach → @file: 引用追加到输入框）。 */
  const onPickFile = useCallback(async () => {
    try {
      setAttaching(true);
      const picked = pickers ? await pickers.pickFile() : await pickFileNative();
      if (!picked) {
        return;
      }
      const refText = await attachFile(sessionId, {
        uri: picked.uri,
        name: picked.name,
        mimeType: picked.mimeType,
      });
      if (refText) {
        appendToInput(onInputChange, input, refText);
      }
      onAttachPanelChange(false);
    } catch (e) {
      if (!pickers && isErrorWithCode(e) && e.code === errorCodes.OPERATION_CANCELED) {
        return;
      }
      alertError(t('input.addFileFailed'), e instanceof Error ? e.message : String(e));
    } finally {
      setAttaching(false);
    }
  }, [attachFile, input, onAttachPanelChange, onInputChange, pickers, sessionId, t]);

  /** 语音识别文本：追加到输入框末尾（可再编辑）。 */
  const onVoiceText = useCallback(
    (text: string) => {
      appendToInput(onInputChange, input, text);
      onAttachPanelChange(false);
    },
    [input, onAttachPanelChange, onInputChange],
  );

  /** 中断后补发的定时器（卸载时清掉，避免悬挂） */
  const interruptFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (interruptFlushTimer.current !== null) {
        clearTimeout(interruptFlushTimer.current);
      }
    },
    [],
  );

  /** 中断当前 turn；随后（延迟一拍）把排队消息的队首补发出去 */
  const onInterrupt = useCallback(() => {
    interrupt(sessionId).then(() => {
      if (interruptFlushTimer.current !== null) {
        clearTimeout(interruptFlushTimer.current);
      }
      interruptFlushTimer.current = setTimeout(() => {
        interruptFlushTimer.current = null;
        forceFlushQueued(sessionId);
      }, INTERRUPT_FLUSH_DELAY_MS);
    });
  }, [interrupt, sessionId]);

  return (
    // 底部操作区整体包一层：白底 + 底部安全区/输入法高度垫高
    <View style={[styles.bottomBar, {paddingBottom: bottomPad}]}>
      {busy ? (
        <View style={styles.statusBar}>
          {/* ① 非 kawaii 的 thinkingHint（⏳/⚠/↻/⚙ provider 等待说明）原文显示；
              ② 否则 status.update 原文显示；③ 都没有时用客户端动画占位
              （服务端 thinking.delta 每次 API 调用只发一条静态 kawaii 帧） */}
          {thinkingHint && !isKawaiiHint(thinkingHint) ? (
            <Text style={styles.statusText} numberOfLines={1}>
              {thinkingHint}
            </Text>
          ) : status?.text ? (
            <Text style={styles.statusText} numberOfLines={1}>
              {status.text}
            </Text>
          ) : (
            <BusyTicker />
          )}
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
      {/* 已排队尚未实际发送的消息（聊天记录底部 / 输入框上方，逐条可取消） */}
      <QueuedPromptStrip sessionId={sessionId} />
      <View style={styles.inputBar}>
        <TouchableOpacity
          style={styles.plusBtn}
          onPress={() => onAttachPanelChange(!attachPanelOpen)}
          disabled={connState !== 'ready'}
          activeOpacity={0.7}
          hitSlop={6}
          accessibilityLabel={
            attachPanelOpen
              ? t('input.attachPanelCollapse')
              : t('input.attachPanelOpen')
          }>
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
          onChangeText={onInputChange}
          onKeyPress={handleKeyPress}
          placeholder={t('input.placeholder')}
          placeholderTextColor={Colors.textSecondary}
          multiline
          editable={connState === 'ready'}
        />
        {busy ? (
          // 动作按钮纵向堆叠（排队在中断正上方）：移动端窄屏下不挤占输入框
          // 的横向空间；排队按钮仅在输入框有内容时出现
          <View style={styles.actionColumn}>
            {input.trim() ? (
              <TouchableOpacity
                style={styles.queueBtn}
                onPress={onSend}
                activeOpacity={0.8}
                accessibilityLabel={t('input.queue')}>
                <Text style={styles.queueBtnText}>{t('input.queue')}</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={styles.interruptBtn}
              onPress={onInterrupt}
              activeOpacity={0.8}
              accessibilityLabel={t('input.interrupt')}>
              <Text style={styles.interruptText}>{t('input.interrupt')}</Text>
            </TouchableOpacity>
          </View>
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
            <Text style={styles.sendText}>{t('input.send')}</Text>
          </TouchableOpacity>
        )}
      </View>
      {attachPanelOpen ? (
        <View style={styles.attachPanel}>
          <View style={styles.imageAttachGroup}>
            <TouchableOpacity
              style={[styles.attachTile, styles.imageAttachTile]}
              onPress={onPickImages}
              disabled={attaching}
              activeOpacity={0.7}
              accessibilityLabel={t('input.sendImage')}>
              <IconImage name="photo" size={26} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.originalToggle}
              onPress={() => setOriginalImage(v => !v)}
              disabled={attaching}
              activeOpacity={0.7}
              accessibilityRole="checkbox"
              accessibilityState={{checked: originalImage}}
              accessibilityLabel={t('input.originalImage')}>
              <View
                style={[
                  styles.originalCheck,
                  originalImage ? styles.originalCheckChecked : null,
                ]}>
                {originalImage ? <Text style={styles.originalCheckMark}>✓</Text> : null}
              </View>
              <Text style={styles.originalText}>{t('input.originalImage')}</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={styles.attachTile}
            onPress={onPickFile}
            disabled={attaching}
            activeOpacity={0.7}
            accessibilityLabel={t('input.sendFile')}>
            <IconImage name="paperclip" size={26} />
          </TouchableOpacity>
          <VoiceButton profile={profile} onText={onVoiceText} />
        </View>
      ) : null}
      {attaching ? (
        <View style={styles.attachingBar}>
          <Text style={styles.attachingText}>{t('input.attaching')}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** 文本追加（带空格分隔），与原 ChatScreen 行为一致。 */
function appendToInput(
  onInputChange: (v: string) => void,
  current: string,
  text: string,
): void {
  const base = current.trimEnd();
  onInputChange(base ? `${base} ${text}` : text);
}

/**
 * 排队消息条 — 显示本会话「已排队、尚未实际发送」的消息内容（聊天记录底部、
 * 输入框上方）。数据来自 queuedPrompts store（按 profile + 持久化会话 id 存，
 * 跨重进/杀进程存活），每条可单独取消（本地出队，此刻还没有任何服务端状态
 * 需要撤销）。
 */
function QueuedPromptStrip({sessionId}: {sessionId: string}) {
  const t = useT();
  // key 组成与 enqueue 同源（两个 string 选择器，引用稳定）
  const profile = useChatStore(s => s.bySession[sessionId]?.profile ?? '');
  const storedId = useChatStore(
    s => s.bySession[sessionId]?.storedSessionId ?? '',
  );
  const key = queuedKeyFor(profile, sessionId, storedId);
  const queued = useQueuedPromptsStore(s => s.queues[key] ?? EMPTY_QUEUED);
  const removeQueued = useQueuedPromptsStore(s => s.removeQueued);
  if (queued.length === 0) {
    return null;
  }
  return (
    <ScrollView
      testID="queued-strip"
      style={styles.queueStrip}
      contentContainerStyle={styles.queueStripContent}
      keyboardShouldPersistTaps="handled">
      {queued.map(item => (
        <View key={item.id} style={styles.queueRow}>
          <Text style={styles.queueBadge}>{t('input.queuedBadge')}</Text>
          <Text style={styles.queueRowText} numberOfLines={2}>
            {item.text}
          </Text>
          <TouchableOpacity
            style={styles.queueRemove}
            hitSlop={8}
            activeOpacity={0.7}
            accessibilityLabel={t('input.queueRemove')}
            onPress={() => removeQueued(item.id)}>
            <Text style={styles.queueRemoveText}>×</Text>
          </TouchableOpacity>
        </View>
      ))}
    </ScrollView>
  );
}

function fallbackImageName(uri: string, mimeType: string | null, idx: number): string {
  const clean = uri.split(/[?#]/, 1)[0].replace(/\\/g, '/');
  const base = clean.slice(clean.lastIndexOf('/') + 1).trim();
  if (base && /\.[a-z0-9]+$/i.test(base)) {
    return base;
  }
  const subtype = (mimeType || '').toLowerCase().startsWith('image/')
    ? (mimeType || '').slice(6).replace(/[^a-z0-9]/gi, '')
    : '';
  return `image_${Date.now()}_${idx}${subtype ? `.${subtype}` : ''}`;
}

/** 手机默认附件来源：documents-picker + 沙盒副本（content:// → file://）。 */
async function pickImagesNative(): Promise<
  {uri: string; name?: string | null; mimeType?: string | null}[]
> {
  const results = await pick({
    type: [types.images],
    allowMultiSelection: true,
  });
  if (!results || results.length === 0) {
    return [];
  }
  const files: {uri: string; name?: string | null; mimeType?: string | null}[] = [];
  let idx = 0;
  for (const r of results) {
    idx += 1;
    const [copy] = await keepLocalCopy({
      files: [
        {uri: r.uri, fileName: r.name ?? fallbackImageName(r.uri, r.type, idx)},
      ],
      destination: 'cachesDirectory',
    });
    if (copy.status === 'success') {
      files.push({uri: copy.localUri, name: r.name, mimeType: r.type});
    }
  }
  return files;
}

async function pickFileNative(): Promise<{
  uri: string;
  name?: string | null;
  mimeType?: string | null;
} | null> {
  const [res] = await pick({type: [types.allFiles]});
  if (!res) {
    return null;
  }
  const [copy] = await keepLocalCopy({
    files: [{uri: res.uri, fileName: res.name ?? 'file'}],
    destination: 'cachesDirectory',
  });
  if (copy.status !== 'success') {
    throw new Error(copy.copyError);
  }
  return {uri: copy.localUri, name: res.name, mimeType: res.type};
}

const styles = StyleSheet.create({
  bottomBar: {backgroundColor: Colors.card},
  statusBar: {
    paddingHorizontal: 14,
    paddingVertical: 4,
    backgroundColor: '#ECEDF2',
  },
  statusText: {fontSize: 12, color: Colors.textSecondary},
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
  /** busy 时的动作按钮列：排队在上、中断在下（纵向堆叠省横向空间） */
  actionColumn: {
    flexDirection: 'column',
    marginLeft: 8,
    alignItems: 'stretch',
  },
  queueBtn: {
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.accent,
    borderRadius: 19,
    paddingHorizontal: 14,
    paddingVertical: 9,
    marginBottom: 6,
    alignItems: 'center',
  },
  queueBtnText: {color: Colors.accentDark, fontSize: 15, fontWeight: '600'},
  interruptBtn: {
    backgroundColor: '#FFF',
    borderWidth: 1,
    borderColor: Colors.danger,
    borderRadius: 19,
    paddingHorizontal: 16,
    paddingVertical: 9,
    justifyContent: 'center',
    alignItems: 'center',
  },
  interruptText: {color: Colors.danger, fontSize: 15, fontWeight: '600'},
  /** 排队消息条（聊天记录底部）：限高滚动，超过三行左右可上下翻 */
  queueStrip: {
    maxHeight: 132,
    backgroundColor: Colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  queueStripContent: {paddingHorizontal: 10, paddingVertical: 6},
  queueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.fillSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
    marginVertical: 2,
  },
  queueBadge: {
    fontSize: 11,
    color: Colors.accentDark,
    marginRight: 6,
  },
  queueRowText: {flex: 1, fontSize: 13, color: Colors.textSecondary},
  queueRemove: {
    width: 20,
    height: 20,
    marginLeft: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  queueRemoveText: {fontSize: 15, color: Colors.textSecondary, lineHeight: 18},
  attachPanel: {
    flexDirection: 'row',
    backgroundColor: Colors.card,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  /** 文件/语音磁贴统一 56 高；图片磁贴下方保留“原图”复选框 */
  attachTile: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 88,
    height: 56,
  },
  imageAttachGroup: {width: 88, alignItems: 'center'},
  imageAttachTile: {height: 36},
  originalToggle: {
    minHeight: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  originalCheck: {
    width: 14,
    height: 14,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  originalCheckChecked: {backgroundColor: Colors.accent, borderColor: Colors.accent},
  originalCheckMark: {color: '#FFF', fontSize: 10, lineHeight: 12},
  originalText: {marginLeft: 4, fontSize: 12, color: Colors.textSecondary},
  attachingBar: {
    backgroundColor: Colors.card,
    paddingVertical: 4,
    alignItems: 'center',
  },
  attachingText: {fontSize: 12, color: Colors.textSecondary},
});
