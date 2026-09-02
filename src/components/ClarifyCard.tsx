import React, {useState} from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import type {ClarifyCardItem, ClarifyQuestion} from '../rpc/types';
import {Colors} from './theme';

interface Props {
  card: ClarifyCardItem;
  /** answer：单选=选项文本；多选=JSON 字符串数组；自由文本=输入内容 */
  onAnswer: (requestId: string, answer: string, questionId?: string) => void;
}

/**
 * 澄清提问卡（clarify.request）：agent 主动向用户提问。
 * 单选点选即答；多选勾选后点「确定」；也可以直接输入自由文本作答。
 * 批量问题逐题作答（每题独立提交，服务端按 qid 归答案）。
 */
export function ClarifyCard({card, onAnswer}: Props) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>💬 需要你的回答</Text>
      {card.questions.map((q, i) => (
        <QuestionRow
          key={q.qid || i}
          question={q}
          answered={card.answeredQids.includes(q.qid ?? '')}
          disabled={card.expired}
          onAnswer={answer => onAnswer(card.requestId, answer, q.qid || undefined)}
        />
      ))}
      {card.expired ? <Text style={styles.expired}>已超时，服务端不再等待</Text> : null}
    </View>
  );
}

function QuestionRow({
  question,
  answered,
  disabled,
  onAnswer,
}: {
  question: ClarifyQuestion;
  answered: boolean;
  disabled?: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const multi = question.multiSelect === true && question.choices.length > 0;

  if (answered) {
    return (
      <View style={styles.questionWrap}>
        <Text style={styles.question}>{question.question}</Text>
        <Text style={styles.answered}>已作答</Text>
      </View>
    );
  }

  const toggle = (choice: string) => {
    if (multi) {
      setSelected(s =>
        s.includes(choice) ? s.filter(c => c !== choice) : [...s, choice],
      );
    } else {
      onAnswer(choice);
    }
  };

  return (
    <View style={styles.questionWrap}>
      <Text style={styles.question}>
        {question.question}
        {multi ? '（可多选）' : ''}
      </Text>
      {question.choices.length > 0 ? (
        <View style={styles.choices}>
          {question.choices.map(choice => {
            const active = multi && selected.includes(choice);
            return (
              <TouchableOpacity
                key={choice}
                style={[styles.choiceBtn, active ? styles.choiceBtnActive : null]}
                activeOpacity={0.75}
                disabled={disabled}
                onPress={() => toggle(choice)}>
                <Text
                  style={[
                    styles.choiceText,
                    active ? styles.choiceTextActive : null,
                  ]}>
                  {choice}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}
      {multi ? (
        <TouchableOpacity
          style={[
            styles.confirmBtn,
            (selected.length === 0 || disabled) && styles.confirmBtnDisabled,
          ]}
          activeOpacity={0.8}
          disabled={selected.length === 0 || disabled}
          onPress={() => onAnswer(JSON.stringify(selected))}>
          <Text style={styles.confirmText}>确定（{selected.length}）</Text>
        </TouchableOpacity>
      ) : null}
      <View style={styles.freeRow}>
        <TextInput
          style={styles.freeInput}
          value={draft}
          onChangeText={setDraft}
          placeholder="或直接输入回答…"
          placeholderTextColor={Colors.textSecondary}
          editable={!disabled}
          onSubmitEditing={() => {
            const t = draft.trim();
            if (t) {
              onAnswer(t);
            }
          }}
        />
        <TouchableOpacity
          style={[styles.freeSend, (!draft.trim() || disabled) && styles.confirmBtnDisabled]}
          activeOpacity={0.8}
          disabled={!draft.trim() || disabled}
          onPress={() => onAnswer(draft.trim())}>
          <Text style={styles.confirmText}>发送</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 12,
    marginVertical: 4,
    backgroundColor: '#EDF6FF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#B3DDF5',
    padding: 12,
  },
  title: {fontSize: 14, fontWeight: '600', color: Colors.text},
  questionWrap: {marginTop: 8},
  question: {fontSize: 14, color: Colors.text, lineHeight: 20},
  answered: {fontSize: 12, color: Colors.textSecondary, marginTop: 4},
  expired: {fontSize: 12, color: Colors.danger, marginTop: 8},
  choices: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 8,
    gap: 8,
  },
  choiceBtn: {
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: Colors.accent,
  },
  choiceBtnActive: {backgroundColor: Colors.accent},
  choiceText: {fontSize: 13, color: Colors.accentDark},
  choiceTextActive: {color: '#FFFFFF', fontWeight: '500'},
  confirmBtn: {
    alignSelf: 'flex-start',
    marginTop: 8,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 7,
    backgroundColor: Colors.accent,
  },
  confirmBtnDisabled: {opacity: 0.4},
  confirmText: {fontSize: 13, color: '#FFFFFF', fontWeight: '500'},
  freeRow: {flexDirection: 'row', marginTop: 8, gap: 8},
  freeInput: {
    flex: 1,
    minHeight: 34,
    backgroundColor: '#FFFFFF',
    borderRadius: 17,
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontSize: 14,
    color: Colors.text,
  },
  freeSend: {
    borderRadius: 17,
    paddingHorizontal: 14,
    justifyContent: 'center',
    backgroundColor: Colors.accent,
  },
});
