import React, {useEffect, useRef} from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';

import {getRpc} from '../rpc/runtime';
import type {ApprovalCardItem, ApprovalChoice} from '../rpc/types';
import {Colors} from './theme';

interface Props {
  card: ApprovalCardItem;
  sessionId: string;
  onRespond: (requestId: string, choice: ApprovalChoice) => void;
}

const CHOICE_LABEL: Record<ApprovalChoice, string> = {
  once: '允许一次',
  session: '本会话允许',
  always: '始终允许',
  deny: '拒绝',
};

/** 审批卡片：内联按钮组，应答后禁用。挂载时发 approval.received 回执。 */
export function ApprovalCard({card, sessionId, onRespond}: Props) {
  const acked = useRef(false);
  useEffect(() => {
    if (acked.current || card.resolved || card.expired) {
      return;
    }
    acked.current = true;
    try {
      getRpc()
        .call('approval.received', {
          session_id: sessionId,
          request_id: card.requestId,
        })
        .catch(() => {});
    } catch {
      // 未连接时忽略回执
    }
  }, [card.requestId, card.resolved, card.expired, sessionId]);

  const resolved = card.resolved;
  return (
    <View style={styles.card}>
      <Text style={styles.title}>🛡 权限审批</Text>
      {card.description ? (
        <Text style={styles.desc}>{card.description}</Text>
      ) : null}
      {card.command ? <Text style={styles.command}>{card.command}</Text> : null}
      {card.expired ? (
        <Text style={styles.resolved}>已超时，服务端不再等待</Text>
      ) : resolved ? (
        <Text style={styles.resolved}>
          已选择：{CHOICE_LABEL[resolved] ?? resolved}
        </Text>
      ) : (
        <View style={styles.buttons}>
          {card.choices.map(choice => (
            <TouchableOpacity
              key={choice}
              style={[
                styles.btn,
                choice === 'deny' ? styles.btnDeny : styles.btnAllow,
              ]}
              onPress={() => onRespond(card.requestId, choice)}
              activeOpacity={0.75}>
              <Text
                style={[
                  styles.btnText,
                  choice === 'deny' ? styles.btnDenyText : null,
                ]}>
                {CHOICE_LABEL[choice] ?? choice}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 12,
    marginVertical: 4,
    backgroundColor: '#FFF7E8',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#FFCF8B',
    padding: 12,
  },
  title: {fontSize: 14, fontWeight: '600', color: Colors.text},
  desc: {fontSize: 13, color: Colors.text, marginTop: 6},
  command: {
    fontSize: 12,
    fontFamily: 'monospace' as never,
    color: Colors.text,
    backgroundColor: '#FFFFFF',
    borderRadius: 6,
    padding: 8,
    marginTop: 6,
  },
  resolved: {fontSize: 12, color: Colors.textSecondary, marginTop: 8},
  buttons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 10,
    gap: 8,
  },
  btn: {
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  btnAllow: {backgroundColor: Colors.accent},
  btnDeny: {backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: Colors.danger},
  btnText: {fontSize: 13, color: '#FFFFFF', fontWeight: '500'},
  btnDenyText: {color: Colors.danger},
});
