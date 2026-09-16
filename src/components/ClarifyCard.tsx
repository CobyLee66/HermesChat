import React, {useMemo, useState} from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import type {ClarifyCardItem, ClarifyQuestion} from '../rpc/types';
import {useT} from '../i18n';
import {Colors} from './theme';

/** 单题草稿：选项选择与自定义文本互斥，后改者生效（点选项清文本、输文本清选项） */
interface Draft {
  selection: string[];
  text: string;
}

interface Props {
  card: ClarifyCardItem;
  /** 整体提交：answers 为全部未答题的草稿答案（answer 单选=选项文本、
   * 多选=JSON 字符串数组、自由文本=原文），store 按题目顺序逐题发送 */
  onSubmit: (
    requestId: string,
    answers: {qid: string; answer: string}[],
  ) => void;
}

/**
 * 澄清提问卡（clarify.request）：agent 主动向用户提问。
 * 交互模型（D052）：卡片内只填草稿——单选点选、多选勾选、自由文本输入均
 * 不即时发送；卡片底部一个「提交回答」按钮整体提交（全部未答题有草稿才
 * 点亮）。协议本身是逐题 clarify.respond（批量问题按 qid 归答案），整体
 * 提交由 store 按题目顺序连发。已答题（本端提交 / resume 回放 / 其他端
 * 锁定）显示问题 + 答案文本；历史 hydrate 合成的只读卡无答案文本。
 */
export function ClarifyCard({card, onSubmit}: Props) {
  const t = useT();
  // 草稿按 qid 键控（单问题 qid=''）；提交成功后行切到已答展示，草稿作废
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const answeredSet = useMemo(
    () => new Set(card.answeredQids),
    [card.answeredQids],
  );
  const openQuestions = card.questions.filter(
    q => !answeredSet.has(q.qid ?? ''),
  );
  const showIndex = card.questions.length > 1;

  const effectiveAnswer = (q: ClarifyQuestion): string => {
    const d = drafts[q.qid ?? ''];
    if (!d) {
      return '';
    }
    const text = d.text.trim();
    if (text) {
      return text;
    }
    if (d.selection.length > 0) {
      // 按选项原始顺序排列；单选=选项文本，多选=JSON 数组串（协议格式）
      const ordered = (q.choices ?? []).filter(c => d.selection.includes(c));
      const list = ordered.length > 0 ? ordered : d.selection;
      return q.multiSelect === true
        ? JSON.stringify(list)
        : list.join('');
    }
    return '';
  };

  const missing = openQuestions.filter(q => !effectiveAnswer(q)).length;
  const submitting = card.submitting === true;
  const canSubmit =
    !card.expired && !submitting && openQuestions.length > 0 && missing === 0;

  const submit = () => {
    const answers = openQuestions
      .map(q => ({qid: q.qid ?? '', answer: effectiveAnswer(q)}))
      .filter(a => a.answer);
    if (answers.length === 0) {
      return;
    }
    onSubmit(card.requestId, answers);
  };

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{t('clarify.title')}</Text>
      {card.questions.map((q, i) => {
        const qid = q.qid ?? '';
        return (
          <QuestionRow
            key={qid || i}
            index={showIndex ? i + 1 : undefined}
            question={q}
            answered={answeredSet.has(qid)}
            answer={card.answers?.[qid]}
            disabled={card.expired || submitting}
            draft={drafts[qid]}
            onDraft={d => setDrafts(prev => ({...prev, [qid]: d}))}
          />
        );
      })}
      {card.expired ? (
        <Text style={styles.expired}>{t('approval.expired')}</Text>
      ) : openQuestions.length > 0 ? (
        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
            activeOpacity={0.8}
            disabled={!canSubmit}
            onPress={submit}>
            {submitting ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.submitText}>{t('clarify.submit')}</Text>
            )}
          </TouchableOpacity>
          {missing > 0 && !submitting ? (
            <Text style={styles.pendingHint}>
              {t('clarify.pendingCount', {count: missing})}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** 展示答案文本：多选是 JSON 数组串，解析后连接展示；其余原样。 */
function prettyAnswer(raw: string): string {
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(x => typeof x === 'string').join(', ');
      }
    } catch {
      // 非 JSON 数组文本，原样展示
    }
  }
  return raw;
}

function QuestionRow({
  index,
  question,
  answered,
  answer,
  disabled,
  draft,
  onDraft,
}: {
  index?: number;
  question: ClarifyQuestion;
  answered: boolean;
  answer?: string;
  disabled?: boolean;
  draft?: Draft;
  onDraft: (d: Draft) => void;
}) {
  const t = useT();
  const multi = question.multiSelect === true && question.choices.length > 0;
  const label = `${index ? `${index}. ` : ''}${question.question}${
    multi ? t('chat.multiHint') : ''
  }`;

  if (answered) {
    return (
      <View style={styles.questionWrap}>
        <Text style={styles.question}>{label}</Text>
        {answer ? (
          <Text style={styles.answerText}>
            {t('clarify.yourAnswer')}：{prettyAnswer(answer)}
          </Text>
        ) : (
          <Text style={styles.answered}>{t('clarify.answered')}</Text>
        )}
      </View>
    );
  }

  const selection = draft?.selection ?? [];
  const text = draft?.text ?? '';

  const toggle = (choice: string) => {
    // 后改者生效：选项操作清空自定义文本
    if (multi) {
      const next = selection.includes(choice)
        ? selection.filter(c => c !== choice)
        : [...selection, choice];
      onDraft({selection: next, text: ''});
    } else {
      onDraft({
        selection: selection.includes(choice) ? [] : [choice],
        text: '',
      });
    }
  };

  return (
    <View style={styles.questionWrap}>
      <Text style={styles.question}>{label}</Text>
      {question.choices.length > 0 ? (
        <View style={styles.choices}>
          {question.choices.map(choice => {
            const active = selection.includes(choice);
            return (
              <TouchableOpacity
                key={choice}
                style={[
                  styles.choiceBtn,
                  active ? styles.choiceBtnActive : null,
                ]}
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
      <TextInput
        style={styles.freeInput}
        value={text}
        onChangeText={v => onDraft({selection: [], text: v})}
        placeholder={t('chat.answerPlaceholder')}
        placeholderTextColor={Colors.textSecondary}
        editable={!disabled}
      />
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
  answerText: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginTop: 4,
    lineHeight: 18,
  },
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
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 12,
  },
  submitBtn: {
    borderRadius: 17,
    paddingHorizontal: 22,
    paddingVertical: 8,
    backgroundColor: Colors.accent,
  },
  submitBtnDisabled: {opacity: 0.4},
  submitText: {fontSize: 13, color: '#FFFFFF', fontWeight: '500'},
  pendingHint: {fontSize: 12, color: Colors.textSecondary},
  freeInput: {
    marginTop: 8,
    minHeight: 34,
    backgroundColor: '#FFFFFF',
    borderRadius: 17,
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontSize: 14,
    color: Colors.text,
  },
});
