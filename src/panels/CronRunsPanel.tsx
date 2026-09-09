/**
 * CronRunsPanel — 定时任务运行历史面板（GET /api/cron/jobs/{id}/runs）。
 * 运行记录即 source=cron 的会话；点记录经 openSessionFlow 打开进聊天页
 * （onOpenSession 由宿主注入：手机导航到 Chat，桌面 openChat）。
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
import {getCronJobRuns} from '../rpc/cron';
import type {CronRunRow, SessionListRow} from '../rpc/types';
import {useConnectionStore} from '../store/connection';
import {alertError} from '../utils/alert';
import {formatEpoch} from '../utils/cronSchedule';
import {openSessionFlow, type OpenedSession} from './sessionFlows';

function RowSeparator() {
  return <View style={styles.sep} />;
}

function toSessionRow(run: CronRunRow): SessionListRow {
  return {
    id: run.id,
    title: run.title || '运行记录',
    preview: run.preview || '',
    started_at: run.started_at ?? 0,
    message_count: run.message_count ?? 0,
    source: 'cron',
  };
}

export function CronRunsPanel({
  jobId,
  profile,
  onOpenSession,
}: {
  jobId: string;
  profile?: string;
  onOpenSession: (opened: OpenedSession) => void;
}) {
  const [runs, setRuns] = useState<CronRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const {httpUrl, token} = useConnectionStore.getState();
      if (!httpUrl) {
        throw new Error('未连接到 gateway');
      }
      const result = await getCronJobRuns(httpUrl, token, jobId, 20, profile);
      setRuns(result.runs ?? []);
      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }, [jobId, profile]);

  useEffect(() => {
    void load();
  }, [load]);

  const openRun = useCallback(
    (run: CronRunRow) => {
      if (opening) {
        return;
      }
      setOpening(run.id);
      openSessionFlow(profile ?? 'default', toSessionRow(run))
        .then(opened => {
          setOpening(null);
          onOpenSession(opened);
        })
        .catch(e => {
          setOpening(null);
          alertError('打开运行会话失败', e instanceof Error ? e.message : String(e));
        });
    },
    [opening, profile, onOpenSession],
  );

  if (loading && runs.length === 0) {
    return <ActivityIndicator style={styles.loading} color={Colors.accent} />;
  }
  if (error && runs.length === 0) {
    return (
      <View style={styles.centerWrap}>
        <Text style={styles.error}>加载失败：{error}</Text>
        <TouchableOpacity onPress={() => void load()} style={styles.retryBtn}>
          <Text style={styles.retryText}>重试</Text>
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
      ListEmptyComponent={<Text style={styles.empty}>暂无运行记录</Text>}
      renderItem={({item}) => (
        <TouchableOpacity
          style={styles.row}
          activeOpacity={0.7}
          disabled={opening === item.id}
          onPress={() => openRun(item)}>
          <View style={styles.rowBody}>
            <View style={styles.rowTop}>
              <Text style={styles.title} numberOfLines={1}>
                {item.title || item.id}
              </Text>
              {item.is_active ? (
                <Text style={styles.activeBadge}>进行中</Text>
              ) : null}
              <Text style={styles.time}>
                {formatEpoch(item.last_active || item.started_at)}
              </Text>
            </View>
            <Text style={styles.preview} numberOfLines={1}>
              {item.preview || '查看会话详情'}
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
