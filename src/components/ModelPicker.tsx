import React, {useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import type {ModelOptionsResult, ModelProviderRow} from '../rpc/types';
import {REASONING_LEVELS} from '../rpc/slash';
import {useT} from '../i18n';
import {Colors} from './theme';

/** ModelPicker 的加载结果：模型分组 + 当前思考等级。 */
export interface ModelPickerData {
  models: ModelOptionsResult;
  /** 当前生效思考等级（config.get reasoning 的 value；'' = 读取失败/老服务端，仅影响当前态高亮） */
  reasoning: string;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /** 拉取 model.options + 当前思考等级（由调用方接 RPC） */
  load: () => Promise<ModelPickerData>;
  /** 选择模型后回调（config.set 由调用方发） */
  onPick: (model: string, provider: string) => void;
  /** 选择思考等级后回调（config.set 由调用方发） */
  onPickReasoning: (level: string) => void;
}

/** 模型切换弹层：原生 bottom sheet；web/桌面为居中对话框。按 provider 分组，顶部带思考等级区。 */
export function ModelPicker({visible, onClose, load, onPick, onPickReasoning}: Props) {
  const [data, setData] = useState<ModelPickerData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const centered = Platform.OS === 'web';

  useEffect(() => {
    if (!visible) {
      return;
    }
    setLoading(true);
    setError(null);
    load()
      .then(setData)
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [visible, load]);

  const rows = (data?.models.providers ?? []).filter(
    p => (p.models?.length ?? 0) > 0 || p.is_current,
  );
  // 服务端 canonical 顺序把用户自定义 provider 固定排最后；这里稳定分区提到前面
  const providers = [
    ...rows.filter(p => p.is_user_defined),
    ...rows.filter(p => !p.is_user_defined),
  ];

  return (
    <Modal
      visible={visible}
      transparent
      animationType={centered ? 'fade' : 'slide'}
      onRequestClose={onClose}>
      {centered ? (
        <TouchableOpacity style={styles.centerBackdrop} activeOpacity={1} onPress={onClose}>
          <View style={[styles.card, styles.centerCard]}>
            <ListBody
              providers={providers}
              data={data}
              loading={loading}
              error={error}
              onPickModel={(m, p) => {
                onPick(m, p);
                onClose();
              }}
              onPickReasoning={lv => {
                onPickReasoning(lv);
                onClose();
              }}
            />
          </View>
        </TouchableOpacity>
      ) : (
        <>
          <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} />
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <ListBody
              providers={providers}
              data={data}
              loading={loading}
              error={error}
              onPickModel={(m, p) => {
                onPick(m, p);
                onClose();
              }}
              onPickReasoning={lv => {
                onPickReasoning(lv);
                onClose();
              }}
            />
          </View>
        </>
      )}
    </Modal>
  );
}

/** 弹层内容（列表/加载/错误），sheet 与居中卡共用。 */
function ListBody({
  providers,
  data,
  loading,
  error,
  onPickModel,
  onPickReasoning,
}: {
  providers: ModelProviderRow[];
  data: ModelPickerData | null;
  loading: boolean;
  error: string | null;
  onPickModel: (model: string, provider: string) => void;
  onPickReasoning: (level: string) => void;
}) {
  const t = useT();
  return (
    <>
      <Text style={styles.title}>{t('model.switchTitle')}</Text>
      {loading ? (
        <ActivityIndicator style={styles.loading} color={Colors.accent} />
      ) : error ? (
        <Text style={styles.error}>{t('model.loadFailed', {error})}</Text>
      ) : (
        <ScrollView style={styles.list}>
          <Text style={styles.providerHeader}>{t('model.reasoningTitle')}</Text>
          <View style={styles.chipRow}>
            {REASONING_LEVELS.map(lv => {
              // 等级名是协议词，原文展示（与顶栏 reasoning_effort 口径一致）
              const active = lv === data?.reasoning;
              return (
                <TouchableOpacity
                  key={lv}
                  style={[styles.chip, active ? styles.chipActive : null]}
                  onPress={() => onPickReasoning(lv)}>
                  <Text
                    style={[styles.chipText, active ? styles.chipTextActive : null]}>
                    {lv}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {providers.map((p: ModelProviderRow) => (
            <View key={p.slug}>
              <Text style={styles.providerHeader}>
                {p.name}
                {p.is_current ? t('chat.currentModel') : ''}
              </Text>
              {(p.models ?? []).slice(0, 30).map(m => {
                const isCurrent = p.is_current && m === data?.models.model;
                return (
                  <TouchableOpacity
                    key={`${p.slug}/${m}`}
                    style={styles.modelRow}
                    onPress={() => onPickModel(m, p.slug)}>
                    <Text
                      style={[
                        styles.modelName,
                        isCurrent ? styles.modelCurrent : null,
                      ]}>
                      {m}
                    </Text>
                    {isCurrent ? <Text style={styles.check}>✓</Text> : null}
                  </TouchableOpacity>
                );
              })}
              {(p.total_models ?? 0) > (p.models?.length ?? 0) ? (
                <Text style={styles.more}>
                  {t('model.more', {count: p.total_models ?? 0})}
                </Text>
              ) : null}
            </View>
          ))}
          {providers.length === 0 ? (
            <Text style={styles.error}>{t('model.empty')}</Text>
          ) : null}
        </ScrollView>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.35)'},
  centerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    backgroundColor: Colors.card,
    paddingBottom: 24,
  },
  centerCard: {
    borderRadius: 12,
    width: 480,
    maxWidth: '86%',
    maxHeight: '70%',
  },
  sheet: {
    backgroundColor: Colors.card,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    maxHeight: '70%',
    paddingBottom: 24,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    marginTop: 8,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: Colors.text,
    textAlign: 'center',
    paddingVertical: 12,
  },
  loading: {marginVertical: 24},
  error: {
    color: Colors.danger,
    textAlign: 'center',
    marginVertical: 20,
    paddingHorizontal: 16,
  },
  list: {paddingHorizontal: 16},
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 8,
    marginBottom: 4,
  },
  chip: {
    borderRadius: 14,
    paddingVertical: 5,
    paddingHorizontal: 12,
    backgroundColor: Colors.fill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.fillBorder,
  },
  chipActive: {backgroundColor: Colors.accent, borderColor: Colors.accent},
  chipText: {fontSize: 13, color: Colors.text},
  chipTextActive: {color: '#FFFFFF', fontWeight: '600'},
  providerHeader: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textSecondary,
    marginTop: 12,
    marginBottom: 4,
  },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  modelName: {fontSize: 15, color: Colors.text, flex: 1},
  modelCurrent: {color: Colors.accent, fontWeight: '600'},
  check: {color: Colors.accent, fontSize: 15},
  more: {fontSize: 12, color: Colors.textSecondary, paddingHorizontal: 8},
});
