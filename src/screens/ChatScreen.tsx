import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
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
import {FileRefCard} from '../components/FileRefCard';
import {ModelPicker} from '../components/ModelPicker';
import {Colors} from '../components/theme';
import {StreamCursor, ThinkingBlock} from '../components/ThinkingBlock';
import {ToolCallCard} from '../components/ToolCallCard';
import {VoiceButton} from '../components/VoiceButton';
import type {AssistantMsg, TimelineItem} from '../rpc/types';
import {useChatStore} from '../store/chat';
import {useConnectionStore} from '../store/connection';
import {useSessionsStore} from '../store/sessions';
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
    switchModel,
    fetchModelOptions,
    attachImages,
    removeAttachment,
    attachFile,
  } = useChatStore();
  const detach = useChatStore(s => s.detach);
  const createSession = useSessionsStore(s => s.create);
  const attach = useChatStore(s => s.attach);
  const connState = useConnectionStore(s => s.state);

  const [input, setInput] = useState('');
  const [menuVisible, setMenuVisible] = useState(false);
  const [modelPickerVisible, setModelPickerVisible] = useState(false);
  const [infoVisible, setInfoVisible] = useState(false);
  const [attachPanelOpen, setAttachPanelOpen] = useState(false);
  const [attaching, setAttaching] = useState(false);

  const items = useMemo(() => chat?.items ?? [], [chat?.items]);
  const invertedItems = useMemo(() => [...items].reverse(), [items]);
  const busy = chat?.busy ?? false;
  const info = chat?.info ?? null;
  const status = chat?.status ?? null;
  const pending = useMemo(
    () => chat?.pendingAttachments ?? [],
    [chat?.pendingAttachments],
  );

  useEffect(() => {
    navigation.setOptions({
      title: title || '会话',
      headerRight: () => (
        <TouchableOpacity onPress={() => setMenuVisible(true)} hitSlop={12}>
          <Text style={styles.menuIcon}>⋯</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation, title]);

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

  const onResetSession = useCallback(() => {
    Alert.alert('重开会话', '将放弃当前上下文，开启全新会话。确定吗？', [
      {text: '取消', style: 'cancel'},
      {
        text: '重开',
        style: 'destructive',
        onPress: async () => {
          try {
            // 注：源码确认 /reset 是 /new 的 gateway_only 别名（commands.py），
            // 经 slash.exec 只会在 slash worker 子进程内执行，无法重置 gateway
            // 会话本身，故"重开会话"退化为 session.create 新会话。
            const result = await createSession(profile);
            detach(sessionId);
            attach(result.session_id, {
              messages: result.messages ?? [],
              info: result.info,
              profile,
              storedSessionId: result.stored_session_id,
            });
            navigation.replace('Chat', {
              sessionId: result.session_id,
              profile,
              title: '新会话',
            });
          } catch (e) {
            Alert.alert('重开失败', e instanceof Error ? e.message : String(e));
          }
        },
      },
    ]);
  }, [attach, createSession, detach, navigation, profile, sessionId]);

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
        case 'assistant':
          return <AssistantRow msg={item} />;
        default:
          return null;
      }
    },
    [respondApproval, sessionId],
  );

  const usage = info?.usage as {total?: number; total_tokens?: number} | undefined;
  const totalTokens = usage?.total ?? usage?.total_tokens;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
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
      <FlatList
        data={invertedItems}
        keyExtractor={it => it.id}
        renderItem={renderItem}
        inverted
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
      />
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
          hitSlop={6}>
          <Text style={styles.plusText}>{attachPanelOpen ? '−' : '＋'}</Text>
        </TouchableOpacity>
        <TextInput
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
            activeOpacity={0.7}>
            <Text style={styles.attachIcon}>🖼</Text>
            <Text style={styles.attachLabel}>相册图片</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.attachTile}
            onPress={onPickFile}
            disabled={attaching}
            activeOpacity={0.7}>
            <Text style={styles.attachIcon}>📎</Text>
            <Text style={styles.attachLabel}>文件</Text>
          </TouchableOpacity>
          <VoiceButton profile={profile} onText={onVoiceText} />
        </View>
      ) : null}
      {attaching ? (
        <View style={styles.attachingBar}>
          <Text style={styles.attachingText}>附件上传中…</Text>
        </View>
      ) : null}

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
                onResetSession();
              }}>
              <Text style={[styles.menuText, styles.menuDanger]}>重开会话</Text>
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
              value={totalTokens !== undefined ? String(totalTokens) : '未知'}
            />
            <InfoRow label="工作目录" value={info?.cwd || '未知'} />
            <InfoRow label="分支" value={info?.branch || '—'} />
            <InfoRow label="Profile" value={info?.profile_name || profile} />
          </View>
        </TouchableOpacity>
      </Modal>
    </KeyboardAvoidingView>
  );
}

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
}: {
  msg: AssistantMsg;
}) {
  return (
    <View style={styles.assistantCol}>
      {msg.blocks.map((b, i) => {
        switch (b.type) {
          case 'text':
            return <Bubble key={i} text={b.text} isUser={false} />;
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
  listContent: {paddingVertical: 10},
  menuIcon: {fontSize: 24, color: Colors.text, paddingHorizontal: 8},
  banner: {
    backgroundColor: '#FFF7E8',
    paddingVertical: 6,
    alignItems: 'center',
  },
  bannerText: {fontSize: 12, color: '#FF7D00'},
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
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  plusText: {fontSize: 20, color: Colors.textSecondary, lineHeight: 24},
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
  attachTile: {alignItems: 'center', width: 88, paddingVertical: 6},
  attachIcon: {fontSize: 26, marginBottom: 4},
  attachLabel: {fontSize: 12, color: Colors.text},
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
    maxHeight: 120,
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
  menuDanger: {color: Colors.danger},
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
});
