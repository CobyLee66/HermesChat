/**
 * CronRunDetailPanel — cron 运行详情面板（只读）。
 *
 * 数据链：GET /api/sessions/{id}/messages（dashboard REST，只读打库、
 * 无 resume 副作用，见 rpc/restSessions.ts 文件头）→ projectRunMessages
 * 投影 → 时间正序渲染。user/assistant 用聊天同款 Bubble，system/
 * 压缩摘要用灰条；tool 行不投影不渲染（与 foreign 只读视图同口径）。
 * 宿主负责页面底色（要求白色与 header 一致）与居中容器。
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

import {Bubble} from '../components/Bubble';
import {Colors} from '../components/theme';
import {getSessionMessages, projectRunMessages} from '../rpc/restSessions';
import type {CronRunRow, ProjectedMessage} from '../rpc/types';
import {useConnectionStore} from '../store/connection';
import {formatEpoch} from '../utils/cronSchedule';

function TranscriptItem({msg}: {msg: ProjectedMessage}) {
  if (msg.role === 'system') {
    return <Text style={styles.sysNote}>{msg.text}</Text>;
  }
  return <Bubble text={msg.text ?? ''} isUser={msg.role === 'user'} />;
}

export function CronRunDetailPanel({
  run,
  jobName,
  onOpenChat,
}: {
  run: CronRunRow;
  /** 所属任务名（元信息展示用） */
  jobName?: string;
  /** 提供则显示「在聊天中打开」入口 */
  onOpenChat?: () => void;
}) {
  const [messages, setMessages] = useState<ProjectedMessage[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const {httpUrl, token} = useConnectionStore.getState();
      if (!httpUrl) {
        throw new Error('未连接到 gateway');
      }
      const result = await getSessionMessages(
        httpUrl,
        token,
        run.id,
        run.profile,
      );
      setMessages(projectRunMessages(result.messages ?? []));
      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }, [run.id, run.profile]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && messages === null) {
    return <ActivityIndicator style={styles.loading} color={Colors.accent} />;
  }
  if (error && messages === null) {
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
      data={messages ?? []}
      keyExtractor={(_, i) => `m${i}`}
      style={styles.list}
      contentContainerStyle={styles.listContent}
      ListHeaderComponent={
        <View style={styles.metaCard}>
          <View style={styles.metaTop}>
            <Text style={styles.metaName} numberOfLines={1}>
              {jobName || run.title || '运行记录'}
            </Text>
            {run.is_active ? (
              <Text style={styles.activeBadge}>进行中</Text>
            ) : (
              <Text style={styles.doneBadge}>已结束</Text>
            )}
          </View>
          <Text style={styles.metaLine}>
            {`开始 ${formatEpoch(run.started_at)}    最近活动 ${formatEpoch(
              run.last_active || run.started_at,
            )}`}
          </Text>
          {onOpenChat ? (
            <TouchableOpacity
              style={styles.chatBtn}
              activeOpacity={0.7}
              onPress={onOpenChat}>
              <Text style={styles.chatBtnText}>在聊天中打开</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      }
      ListEmptyComponent={
        <Text style={styles.empty}>该次运行没有产生对话内容</Text>
      }
      renderItem={({item}) => <TranscriptItem msg={item} />}
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
  list: {flex: 1},
  listContent: {paddingHorizontal: 12, paddingBottom: 24},
  metaCard: {
    backgroundColor: Colors.fillSubtle,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    padding: 12,
    marginBottom: 10,
  },
  metaTop: {flexDirection: 'row', alignItems: 'center'},
  metaName: {
    flexShrink: 1,
    fontSize: 14,
    fontWeight: '600',
    color: Colors.text,
  },
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
  doneBadge: {
    fontSize: 10,
    color: Colors.textSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    marginLeft: 6,
    overflow: 'hidden',
  },
  metaLine: {fontSize: 12, color: Colors.textSecondary, marginTop: 6},
  chatBtn: {
    alignSelf: 'flex-start',
    marginTop: 8,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  chatBtnText: {fontSize: 12, color: Colors.accentDark},
  sysNote: {
    alignSelf: 'center',
    textAlign: 'center',
    maxWidth: '92%',
    color: Colors.textSecondary,
    fontSize: 12,
    backgroundColor: Colors.thinkingBg,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginVertical: 4,
    overflow: 'hidden',
  },
  empty: {
    textAlign: 'center',
    color: Colors.textSecondary,
    marginTop: 48,
    fontSize: 14,
  },
});
