/**
 * ChatInputBar — 聊天底部操作区面板：busy 状态条、待发附件横条、输入栏
 * （+按钮 / 多行输入 / 发送或中断）、附件面板、上传中提示。
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
import {useChatStore} from '../store/chat';
import {useConnectionStore} from '../store/connection';
import {alertError} from '../utils/alert';
import {isKawaiiHint} from '../utils/busyTicker';
import {useKeyboardHeight} from '../utils/useKeyboardHeight';

/** 附件来源注入：桌面传对话框实现，缺省用手机 documents-picker 流程。 */
export interface ChatAttachmentPickers {
  pickImages(): Promise<{uri: string; name?: string | null}[]>;
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
  const chat = useChatStore(s => s.bySession[sessionId]);
  const {interrupt, attachImages, removeAttachment, attachFile} = useChatStore();
  const connState = useConnectionStore(s => s.state);

  const [attaching, setAttaching] = React.useState(false);

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

  /** 附件面板：相册图片（多选 → 压缩 → image.attach_bytes → 待发横条）。 */
  const onPickImages = useCallback(async () => {
    try {
      setAttaching(true);
      const files = pickers ? await pickers.pickImages() : await pickImagesNative();
      if (files.length > 0) {
        await attachImages(sessionId, files);
      }
      onAttachPanelChange(false);
    } catch (e) {
      if (!pickers && isErrorWithCode(e) && e.code === errorCodes.OPERATION_CANCELED) {
        return;
      }
      alertError('选择图片失败', e instanceof Error ? e.message : String(e));
    } finally {
      setAttaching(false);
    }
  }, [attachImages, onAttachPanelChange, pickers, sessionId]);

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
      alertError('添加文件失败', e instanceof Error ? e.message : String(e));
    } finally {
      setAttaching(false);
    }
  }, [attachFile, input, onAttachPanelChange, onInputChange, pickers, sessionId]);

  /** 语音识别文本：追加到输入框末尾（可再编辑）。 */
  const onVoiceText = useCallback(
    (text: string) => {
      appendToInput(onInputChange, input, text);
      onAttachPanelChange(false);
    },
    [input, onAttachPanelChange, onInputChange],
  );

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
      <View style={styles.inputBar}>
        <TouchableOpacity
          style={styles.plusBtn}
          onPress={() => onAttachPanelChange(!attachPanelOpen)}
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
          onChangeText={onInputChange}
          onKeyPress={handleKeyPress}
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

/** 手机默认附件来源：documents-picker + 沙盒副本（content:// → file://）。 */
async function pickImagesNative(): Promise<
  {uri: string; name?: string | null}[]
> {
  const results = await pick({
    type: [types.images],
    allowMultiSelection: true,
  });
  if (!results || results.length === 0) {
    return [];
  }
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
  attachPanel: {
    flexDirection: 'row',
    backgroundColor: Colors.card,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  /** 面板三格统一 56 高（与 VoiceButton 磁贴一致），纯图标无文字 */
  attachTile: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 88,
    height: 56,
  },
  attachingBar: {
    backgroundColor: Colors.card,
    paddingVertical: 4,
    alignItems: 'center',
  },
  attachingText: {fontSize: 12, color: Colors.textSecondary},
});
