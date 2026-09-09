/**
 * CronJobForm — 定时任务新建/编辑表单（纯 props，手机屏与桌面 Modal 共用）。
 * 字段：名称 / 提示词 / 计划（六模式 ScheduleBuilder）/ 投递目标 / 归属
 * profile（仅新建）/ 跟随上次输出（continuity → context_from ['self']）。
 * 下拉选择统一用居中 Modal 卡（ScrollView 内锚定菜单会随滚动漂移，弃用）。
 */

import React, {useEffect, useMemo, useState} from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';

import {Colors} from '../components/theme';
import {createCronJob, getCronJob, getDeliveryTargets, updateCronJob} from '../rpc/cron';
import type {CronDeliveryTarget, CronJob} from '../rpc/types';
import {useConnectionStore} from '../store/connection';
import {useCronStore} from '../store/cron';
import {alertError} from '../utils/alert';
import {
  DEFAULT_SCHEDULE_FIELDS,
  SCHEDULE_MODE_LABELS,
  buildScheduleString,
  parseSchedule,
  type ScheduleFields,
  type ScheduleMode,
} from '../utils/cronSchedule';

const WEEKDAY_CHIPS: {key: number; label: string}[] = [
  {key: 1, label: '一'},
  {key: 2, label: '二'},
  {key: 3, label: '三'},
  {key: 4, label: '四'},
  {key: 5, label: '五'},
  {key: 6, label: '六'},
  {key: 0, label: '日'},
];

/** 'HH:mm' → {hour, minute}；非法返回 null。 */
function parseTimeText(text: string): {hour: number; minute: number} | null {
  const m = text.trim().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) {
    return null;
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) {
    return null;
  }
  return {hour, minute};
}

function fieldsToTimeText(f: ScheduleFields): string {
  return `${String(f.hour).padStart(2, '0')}:${String(f.minute).padStart(2, '0')}`;
}

/**
 * 编辑预填数据：优先 cron store（列表已是完整记录），store 缺失（罕见深链
 * 入口）时直接拉单个兜底。手机 CronEditScreen 与桌面 CronEditModal 共用。
 */
export function useCronJobDraft(
  jobId?: string,
  profile?: string,
): {job: CronJob | null; error: string | null; loading: boolean} {
  const storeJob = useCronStore(s =>
    jobId ? (s.jobs.find(j => j.id === jobId) ?? null) : null,
  );
  const [fallbackJob, setFallbackJob] = useState<CronJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId || storeJob) {
      return;
    }
    const {httpUrl, token} = useConnectionStore.getState();
    if (!httpUrl) {
      return;
    }
    getCronJob(httpUrl, token, jobId, profile)
      .then(setFallbackJob)
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [jobId, storeJob, profile]);

  return {
    job: storeJob ?? fallbackJob,
    error,
    loading: !!jobId && !storeJob && !fallbackJob && !error,
  };
}

/** 居中选择卡（模式/投递目标/profile 共用）。 */
function PickerModal<T extends string>({
  visible,
  title,
  value,
  options,
  onPick,
  onClose,
}: {
  visible: boolean;
  title: string;
  value: T | null;
  options: {key: T; label: string; hint?: string}[];
  onPick: (key: T) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{title}</Text>
            {options.map(o => (
              <TouchableOpacity
                key={o.key}
                style={styles.optionRow}
                activeOpacity={0.6}
                onPress={() => onPick(o.key)}>
                <Text
                  style={[
                    styles.optionText,
                    o.key === value && styles.optionTextActive,
                  ]}
                  numberOfLines={1}>
                  {o.label}
                </Text>
                {o.hint ? (
                  <Text style={styles.optionHint}>{o.hint}</Text>
                ) : null}
                {o.key === value ? (
                  <Text style={styles.optionCheck}>✓</Text>
                ) : null}
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

export function CronJobForm({
  job,
  profiles,
  defaultProfile,
  onSaved,
}: {
  job: CronJob | null;
  /** 可选归属 profile（新建时选择；编辑时归属不可改） */
  profiles: string[];
  defaultProfile?: string;
  onSaved: (saved: CronJob) => void;
}) {
  const [name, setName] = useState(job?.name ?? '');
  const [prompt, setPrompt] = useState(job?.prompt ?? '');
  const [mode, setMode] = useState<ScheduleMode>('interval');
  const [fields, setFields] = useState<ScheduleFields>(DEFAULT_SCHEDULE_FIELDS);
  const [deliver, setDeliver] = useState('local');
  const [targets, setTargets] = useState<CronDeliveryTarget[]>([]);
  const [profile, setProfile] = useState(defaultProfile ?? profiles[0] ?? '');
  const [continuity, setContinuity] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<'mode' | 'deliver' | 'profile' | null>(
    null,
  );

  // 预填（编辑）：schedule 结构反解为模式与字段
  useEffect(() => {
    if (!job) {
      return;
    }
    const parsed = parseSchedule(job);
    setMode(parsed.mode);
    setFields(parsed.fields);
    setDeliver(job.deliver || 'local');
    setContinuity(!!job.context_from?.includes('self'));
  }, [job]);

  // 投递目标下拉选项（始终含 local，服务端保证）
  useEffect(() => {
    const {httpUrl, token} = useConnectionStore.getState();
    if (!httpUrl) {
      return;
    }
    getDeliveryTargets(httpUrl, token)
      .then(r => setTargets(r.targets ?? []))
      .catch(() => setTargets([]));
  }, []);

  const patchFields = (over: Partial<ScheduleFields>) =>
    setFields(f => ({...f, ...over}));

  const modeLabel =
    SCHEDULE_MODE_LABELS.find(m => m.key === mode)?.label ?? mode;
  const deliverLabel = deliver === 'local' && targets.length === 0
    ? 'local'
    : targets.find(t => t.id === deliver)?.name ?? deliver;

  const buildSchedule = (): string | null => {
    const schedule = buildScheduleString(mode, fields);
    if (!schedule) {
      alertError(
        '计划未填写完整',
        mode === 'once'
          ? '请填写一次性运行时间（YYYY-MM-DD HH:mm）'
          : '请完整填写计划参数',
      );
      return null;
    }
    return schedule;
  };

  const onSave = async () => {
    if (busy) {
      return;
    }
    if (!prompt.trim()) {
      alertError('提示词必填', '定时运行时 agent 收到的自包含指令');
      return;
    }
    const schedule = buildSchedule();
    if (!schedule) {
      return;
    }
    setBusy(true);
    try {
      const {httpUrl, token} = useConnectionStore.getState();
      if (!httpUrl) {
        throw new Error('未连接到 gateway');
      }
      const trimmedName = name.trim();
      if (job) {
        const saved = await updateCronJob(
          httpUrl,
          token,
          job.id,
          {
            // 可选字段显式传 null 清空（dashboard 同语义，避免残留旧值）
            name: trimmedName || null,
            prompt: prompt.trim(),
            schedule,
            deliver,
            context_from: continuity ? ['self'] : null,
          },
          job.profile,
        );
        onSaved(saved);
      } else {
        const saved = await createCronJob(
          httpUrl,
          token,
          {
            name: trimmedName || undefined,
            prompt: prompt.trim(),
            schedule,
            deliver,
            context_from: continuity ? ['self'] : undefined,
          },
          profile || undefined,
        );
        onSaved(saved);
      }
    } catch (e) {
      alertError('保存失败', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const profileOptions = useMemo(
    () => profiles.map(p => ({key: p, label: p})),
    [profiles],
  );

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.container}>
      <Text style={styles.label}>名称（可选）</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="留空自动取提示词前缀"
        placeholderTextColor={Colors.textSecondary}
        maxLength={200}
      />

      <Text style={styles.label}>提示词</Text>
      <TextInput
        style={[styles.input, styles.promptInput]}
        value={prompt}
        onChangeText={setPrompt}
        placeholder="每次定时运行时 agent 收到的指令"
        placeholderTextColor={Colors.textSecondary}
        multiline
      />

      <Text style={styles.label}>计划</Text>
      {mode === 'interval' ? (
        <View style={styles.inlineRow}>
          <Text style={styles.inlineLabel}>每</Text>
          <TextInput
            style={[styles.input, styles.smallInput]}
            value={String(fields.intervalCount)}
            onChangeText={t =>
              patchFields({intervalCount: Number(t.replace(/[^\d]/g, '')) || 0})
            }
            keyboardType="number-pad"
          />
          {(['m', 'h', 'd'] as const).map(u => (
            <TouchableOpacity
              key={u}
              style={[styles.chip, fields.intervalUnit === u && styles.chipActive]}
              onPress={() => patchFields({intervalUnit: u})}>
              <Text
                style={[
                  styles.chipText,
                  fields.intervalUnit === u && styles.chipTextActive,
                ]}>
                {u === 'm' ? '分钟' : u === 'h' ? '小时' : '天'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
      {mode === 'daily' || mode === 'weekly' || mode === 'monthly' ? (
        <TextInput
          style={[styles.input, styles.timeInput]}
          value={fieldsToTimeText(fields)}
          onChangeText={t => {
            const parsed = parseTimeText(t);
            if (parsed) {
              patchFields({hour: parsed.hour, minute: parsed.minute});
            }
          }}
          placeholder="HH:mm"
          placeholderTextColor={Colors.textSecondary}
        />
      ) : null}
      {mode === 'weekly' ? (
        <View style={styles.chipRow}>
          {WEEKDAY_CHIPS.map(chip => {
            const active = fields.weekdays.includes(chip.key);
            return (
              <TouchableOpacity
                key={chip.key}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() =>
                  patchFields({
                    weekdays: active
                      ? fields.weekdays.filter(w => w !== chip.key)
                      : [...fields.weekdays, chip.key],
                  })
                }>
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {`周${chip.label}`}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}
      {mode === 'monthly' ? (
        <View style={styles.inlineRow}>
          <Text style={styles.inlineLabel}>每月</Text>
          <TextInput
            style={[styles.input, styles.smallInput]}
            value={String(fields.monthDay)}
            onChangeText={t =>
              patchFields({monthDay: Number(t.replace(/[^\d]/g, '')) || 1})
            }
            keyboardType="number-pad"
          />
          <Text style={styles.inlineLabel}>日</Text>
        </View>
      ) : null}
      {mode === 'once' ? (
        <TextInput
          style={styles.input}
          value={fields.onceIso.replace('T', ' ')}
          onChangeText={t => patchFields({onceIso: t.trim().replace(' ', 'T')})}
          placeholder="2026-02-03 14:00"
          placeholderTextColor={Colors.textSecondary}
        />
      ) : null}
      {mode === 'custom' ? (
        <TextInput
          style={styles.input}
          value={fields.customExpr}
          onChangeText={t => patchFields({customExpr: t})}
          placeholder="cron 表达式，如 0 9 * * 1-5"
          placeholderTextColor={Colors.textSecondary}
        />
      ) : null}
      <TouchableOpacity
        style={styles.pickerBtn}
        activeOpacity={0.7}
        onPress={() => setPicker('mode')}>
        <Text style={styles.pickerBtnLabel}>模式</Text>
        <Text style={styles.pickerBtnValue}>{modeLabel}</Text>
        <Text style={styles.pickerBtnCaret}>▾</Text>
      </TouchableOpacity>

      <Text style={styles.label}>投递目标</Text>
      <TouchableOpacity
        style={styles.pickerBtn}
        activeOpacity={0.7}
        onPress={() => setPicker('deliver')}>
        <Text style={styles.pickerBtnValue}>{deliverLabel}</Text>
        <Text style={styles.pickerBtnCaret}>▾</Text>
      </TouchableOpacity>

      {!job && profiles.length > 0 ? (
        <>
          <Text style={styles.label}>归属 profile</Text>
          <TouchableOpacity
            style={styles.pickerBtn}
            activeOpacity={0.7}
            onPress={() => setPicker('profile')}>
            <Text style={styles.pickerBtnValue}>{profile || '选择 profile'}</Text>
            <Text style={styles.pickerBtnCaret}>▾</Text>
          </TouchableOpacity>
        </>
      ) : null}

      <TouchableOpacity
        style={styles.checkRow}
        activeOpacity={0.7}
        onPress={() => setContinuity(v => !v)}>
        <View style={[styles.checkbox, continuity && styles.checkboxActive]}>
          {continuity ? <Text style={styles.checkboxMark}>✓</Text> : null}
        </View>
        <Text style={styles.checkText}>跟随上次输出（注入该任务上次的结果）</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.saveBtn, busy && styles.btnDisabled]}
        onPress={() => void onSave()}
        disabled={busy}
        activeOpacity={0.8}>
        <Text style={styles.saveText}>{busy ? '保存中…' : '保存'}</Text>
      </TouchableOpacity>

      <PickerModal
        visible={picker === 'mode'}
        title="计划模式"
        value={mode}
        options={SCHEDULE_MODE_LABELS.map(m => ({key: m.key, label: m.label}))}
        onPick={key => {
          setMode(key);
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
      <PickerModal
        visible={picker === 'deliver'}
        title="投递目标"
        value={deliver}
        options={
          targets.length > 0
            ? targets.map(t => ({
                key: t.id,
                label: t.name || t.id,
                hint: t.home_target_set ? undefined : '未配置 home 渠道',
              }))
            : [{key: 'local', label: 'local'}]
        }
        onPick={key => {
          setDeliver(key);
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
      <PickerModal
        visible={picker === 'profile'}
        title="归属 profile"
        value={profile || null}
        options={profileOptions}
        onPick={key => {
          setProfile(key);
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {padding: 20},
  label: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginBottom: 6,
    marginTop: 14,
  },
  input: {
    backgroundColor: Colors.card,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: Colors.text,
  },
  promptInput: {minHeight: 90, textAlignVertical: 'top'},
  inlineRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  smallInput: {width: 90, textAlign: 'center'},
  timeInput: {width: 120},
  inlineLabel: {fontSize: 14, color: Colors.text},
  chipRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8},
  chip: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    paddingVertical: 5,
    backgroundColor: Colors.card,
  },
  chipActive: {backgroundColor: '#E8F7FF', borderColor: Colors.accent},
  chipText: {fontSize: 13, color: Colors.textSecondary},
  chipTextActive: {color: Colors.accentDark, fontWeight: '600'},
  pickerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: Colors.fillSubtle,
    borderRadius: 9,
    paddingVertical: 8,
    paddingHorizontal: 12,
    minWidth: 140,
  },
  pickerBtnLabel: {fontSize: 13, color: Colors.textSecondary, marginRight: 8},
  pickerBtnValue: {fontSize: 14, color: Colors.text, flexShrink: 1},
  pickerBtnCaret: {fontSize: 10, color: Colors.textSecondary, marginLeft: 6},
  checkRow: {flexDirection: 'row', alignItems: 'center', marginTop: 18},
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: Colors.fillBorder,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.card,
  },
  checkboxActive: {backgroundColor: Colors.accent, borderColor: Colors.accent},
  checkboxMark: {fontSize: 13, color: '#FFF'},
  checkText: {fontSize: 13, color: Colors.text, marginLeft: 8, flex: 1},
  saveBtn: {
    marginTop: 24,
    backgroundColor: Colors.accent,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  btnDisabled: {opacity: 0.5},
  saveText: {color: '#FFF', fontSize: 15, fontWeight: '600'},
  // 居中选择卡
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCard: {
    width: 260,
    maxHeight: 420,
    backgroundColor: Colors.card,
    borderRadius: 12,
    paddingVertical: 6,
  },
  modalTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textSecondary,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
    marginBottom: 4,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  optionText: {fontSize: 14, color: Colors.text, flexShrink: 1},
  optionTextActive: {color: Colors.accentDark, fontWeight: '600'},
  optionHint: {fontSize: 11, color: '#FF7D00', marginLeft: 8},
  optionCheck: {fontSize: 14, color: Colors.accent, marginLeft: 8},
});
