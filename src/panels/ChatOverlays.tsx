/**
 * ChatOverlays — 聊天弹层集合（顶栏菜单 / ModelPicker / 会话信息卡 / 重命名）。
 * 手机 ChatScreen 与桌面 ChatPane 共用；开关状态由调用方持有。
 */

import React, {useCallback, useState} from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import {ModelPicker} from '../components/ModelPicker';
import {Colors} from '../components/theme';
import {useChatStore} from '../store/chat';
import {alertError} from '../utils/alert';
import {deleteSessionFlow} from './sessionFlows';

export interface ChatOverlaysState {
  menuVisible: boolean;
  modelPickerVisible: boolean;
  infoVisible: boolean;
}

export function ChatOverlays({
  sessionId,
  profile,
  state,
  setState,
  showDetail,
  onToggleShowDetail,
  onSessionDeleted,
}: {
  sessionId: string;
  profile: string;
  state: ChatOverlaysState;
  setState: (patch: Partial<ChatOverlaysState>) => void;
  /** 是否显示工具调用/思考（菜单项展示切换文案） */
  showDetail: boolean;
  onToggleShowDetail: () => void;
  /** 会话被删除后调用（手机 goBack / 桌面关聊天列） */
  onSessionDeleted?: () => void;
}) {
  const info = useChatStore(s => s.bySession[sessionId]?.info ?? null);
  // foreign 只读会话（未 resume 的 multiplex 大库行）：改名/删除 RPC 都够不到，
  // 菜单里隐藏这两项
  const foreign = useChatStore(s => s.bySession[sessionId]?.foreign ?? null);
  const {switchModel, fetchModelOptions} = useChatStore();

  // 改名弹窗（本地状态：仅本组件渲染）
  const [rename, setRename] = useState<{visible: boolean; text: string}>({
    visible: false,
    text: '',
  });

  const openRename = useCallback(() => {
    setState({menuVisible: false});
    const current = useChatStore.getState().bySession[sessionId]?.title ?? '';
    setRename({visible: true, text: current});
  }, [sessionId, setState]);

  const closeRename = useCallback(
    () => setRename(r => ({...r, visible: false})),
    [],
  );

  const submitRename = useCallback(() => {
    const next = rename.text.trim();
    setRename({visible: false, text: ''});
    if (!next) {
      return;
    }
    useChatStore
      .getState()
      .renameSession(sessionId, next)
      .catch(e =>
        alertError('重命名失败', e instanceof Error ? e.message : String(e)),
      );
  }, [rename.text, sessionId]);

  const onDelete = useCallback(() => {
    setState({menuVisible: false});
    void (async () => {
      const current = useChatStore.getState().bySession[sessionId]?.title ?? '';
      const deleted = await deleteSessionFlow(profile, sessionId, current);
      if (deleted) {
        onSessionDeleted?.();
      }
    })();
  }, [sessionId, profile, setState, onSessionDeleted]);

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
    <>
      {/* 顶栏菜单 */}
      <Modal
        visible={state.menuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setState({menuVisible: false})}>
        <TouchableOpacity
          style={styles.menuBackdrop}
          activeOpacity={1}
          onPress={() => setState({menuVisible: false})}>
          <View style={styles.menu}>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setState({menuVisible: false, modelPickerVisible: true});
              }}>
              <Text style={styles.menuText}>切换模型</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setState({menuVisible: false, infoVisible: true});
              }}>
              <Text style={styles.menuText}>会话信息</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setState({menuVisible: false});
                onToggleShowDetail();
              }}>
              <Text style={styles.menuText}>
                {showDetail ? '隐藏工具与思考' : '显示工具与思考'}
              </Text>
            </TouchableOpacity>
            {foreign ? null : (
              <>
                <TouchableOpacity style={styles.menuItem} onPress={openRename}>
                  <Text style={styles.menuText}>重命名会话</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.menuItem} onPress={onDelete}>
                  <Text style={styles.menuTextDanger}>删除会话</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </TouchableOpacity>
      </Modal>

      <ModelPicker
        visible={state.modelPickerVisible}
        onClose={() => setState({modelPickerVisible: false})}
        load={() => fetchModelOptions(sessionId)}
        onPick={(model, provider) => {
          switchModel(sessionId, model, provider).catch(e =>
            alertError('切换失败', e instanceof Error ? e.message : String(e)),
          );
        }}
      />

      {/* 会话信息弹层（数据来自 session.info 事件/create-resume 结果） */}
      <Modal
        visible={state.infoVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setState({infoVisible: false})}>
        <TouchableOpacity
          style={styles.menuBackdrop}
          activeOpacity={1}
          onPress={() => setState({infoVisible: false})}>
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
            {contextText ? (
              <InfoRow label="上下文窗口" value={contextText} />
            ) : null}
            <InfoRow label="工作目录" value={info?.cwd || '未知'} />
            <InfoRow label="分支" value={info?.branch || '—'} />
            <InfoRow label="Profile" value={info?.profile_name || profile} />
          </View>
        </TouchableOpacity>
      </Modal>

      {/* 重命名弹窗：session.title RPC 写形式，成功后头部/列表即时刷新（D032） */}
      <Modal
        visible={rename.visible}
        transparent
        animationType="fade"
        onRequestClose={closeRename}>
        <TouchableOpacity
          style={styles.menuBackdrop}
          activeOpacity={1}
          onPress={closeRename}>
          <View style={styles.infoCard}>
            <Text style={styles.infoTitle}>重命名会话</Text>
            <TextInput
              style={styles.renameInput}
              value={rename.text}
              onChangeText={t => setRename(r => ({...r, text: t}))}
              placeholder="输入新的会话标题"
              placeholderTextColor={Colors.textSecondary}
              autoFocus
              selectTextOnFocus
              onSubmitEditing={submitRename}
              returnKeyType="done"
            />
            <View style={styles.renameActions}>
              <TouchableOpacity
                style={styles.renameBtn}
                activeOpacity={0.8}
                onPress={closeRename}>
                <Text style={styles.renameBtnText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.renameBtnPrimary}
                activeOpacity={0.8}
                onPress={submitRename}>
                <Text style={styles.renameBtnPrimaryText}>重命名</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    </>
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

const styles = StyleSheet.create({
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
  menuTextDanger: {fontSize: 15, color: Colors.danger},
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
  renameInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    borderRadius: 8,
    backgroundColor: Colors.bg,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: Colors.text,
    marginBottom: 14,
  },
  renameActions: {flexDirection: 'row', justifyContent: 'flex-end', gap: 10},
  renameBtn: {
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  renameBtnText: {fontSize: 14, color: Colors.textSecondary},
  renameBtnPrimary: {
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 18,
    backgroundColor: Colors.accent,
  },
  renameBtnPrimaryText: {fontSize: 14, color: '#FFFFFF', fontWeight: '600'},
});
