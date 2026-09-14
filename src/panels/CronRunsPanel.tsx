/**
 * CronRunsPanel — 定时任务运行历史面板（GET /api/cron/jobs/{id}/runs）。
 * 运行记录即 source=cron 的会话；点记录经 onOpenRun 由宿主打开运行详情
 * （手机导航 CronRunDetail，桌面弹 CronRunDetailModal）。
 */

import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import {Colors} from '../components/theme';
import {useT} from '../i18n';
import {getCronJobRuns} from '../rpc/cron';
import type {CronRunRow} from '../rpc/types';
import {useConnectionStore} from '../store/connection';
import {formatEpoch} from '../utils/cronSchedule';

function RowSeparator() {
  return <View style={styles.sep} />;
}

export function CronRunsPanel({
  jobId,
  profile,
  onOpenRun,
}: {
  jobId: string;
  profile?: string;
  onOpenRun: (run: CronRunRow) => void;
}) {
  const t = useT();
  const [runs, setRuns] = useState<CronRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const {httpUrl, token} = useConnectionStore.getState();
      if (!httpUrl) {
        throw new Error(t('cron.notConnected'));
      }
      const result = await getCronJobRuns(httpUrl, token, jobId, 20, profile);
      setRuns(result.runs ?? []);
      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }, [jobId, profile, t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && runs.length === 0) {
    return <ActivityIndicator style={styles.loading} color={Colors.accent} />;
  }
  if (error && runs.length === 0) {
    return (
      <View style={styles.centerWrap}>
        <Text style={styles.error}>{t('cron.loadFailed', {error})}</Text>
        <TouchableOpacity onPress={() => void load()} style={styles.retryBtn}>
          <Text style={styles.retryText}>{t('cron.retry')}</Text>
        </TouchableOpacity>
      </View>
    );
  }
  return (
    <FlatList
      data={runs}
      keyExtractor={r => r.id}
      refreshing={loading}
      onRefresh={() => void load()}
      ItemSeparatorComponent={RowSeparator}
      ListEmptyComponent={<Text style={styles.empty}>{t('cron.runsEmpty')}</Text>}
      renderItem={({item}) => (
        <TouchableOpacity
          style={styles.row}
          activeOpacity={0.7}
          onPress={() => onOpenRun(item)}>
          <View style={styles.rowBody}>
            <View style={styles.rowTop}>
              <Text style={styles.title} numberOfLines={1}>
                {item.title || item.id}
              </Text>
              {item.is_active ? (
                <Text style={styles.activeBadge}>{t('cron.runActive')}</Text>
              ) : null}
              <Text style={styles.time}>
                {formatEpoch(item.last_active || item.started_at)}
              </Text>
            </View>
            <Text style={styles.preview} numberOfLines={1}>
              {item.preview || t('cron.viewRunDetail')}
            </Text>
          </View>
        </TouchableOpacity>
      )}
    />
  );
}

const styles = StyleSheet.create({
  loading: {marginTop: 48},
  centerWrap: {alignItems: 'center', marginTop: 48},
  error: {color: Colors.danger, fontSize: 14},
  retryBtn: {
    marginTop: 12,
    backgroundColor: Colors.accent,
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  retryText: {color: '#FFF', fontSize: 14},
  empty: {
    textAlign: 'center',
    color: Colors.textSecondary,
    marginTop: 60,
    fontSize: 14,
  },
  sep: {height: StyleSheet.hairlineWidth, backgroundColor: Colors.border},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  rowBody: {flex: 1},
  rowTop: {flexDirection: 'row', alignItems: 'center'},
  title: {fontSize: 15, fontWeight: '500', color: Colors.text, flexShrink: 1},
  activeBadge: {
    fontSize: 10,
    color: Colors.success,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.success,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    marginLeft: 6,
    overflow: 'hidden',
  },
  time: {fontSize: 11, color: Colors.textSecondary, marginLeft: 8},
  preview: {fontSize: 13, color: Colors.textSecondary, marginTop: 2},
});
