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
import {useT} from '../i18n';
import {Colors} from './theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** 拉取 model.options（由调用方接 RPC） */
  load: () => Promise<ModelOptionsResult>;
  /** 选择模型后回调（config.set 由调用方发） */
  onPick: (model: string, provider: string) => void;
}

/** 模型切换弹层：原生 bottom sheet；web/桌面为居中对话框。按 provider 分组。 */
export function ModelPicker({visible, onClose, load, onPick}: Props) {
  const [data, setData] = useState<ModelOptionsResult | null>(null);
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

  const rows = (data?.providers ?? []).filter(
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
}: {
  providers: ModelProviderRow[];
  data: ModelOptionsResult | null;
  loading: boolean;
  error: string | null;
  onPickModel: (model: string, provider: string) => void;
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
          {providers.map((p: ModelProviderRow) => (
            <View key={p.slug}>
              <Text style={styles.providerHeader}>
                {p.name}
                {p.is_current ? t('chat.currentModel') : ''}
              </Text>
              {(p.models ?? []).slice(0, 30).map(m => {
                const isCurrent = p.is_current && m === data?.model;
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
