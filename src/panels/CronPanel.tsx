/**
 * CronPanel — 定时任务面板（profile 筛选 + 任务列表 + 行操作菜单）。
 * 手机 Cron 视图与桌面壳共用；导航差异（新建/编辑/运行历史）经回调注入。
 * 数据来自 useCronStore（dashboard REST /api/cron/*，cron.changed 自动刷新）。
 */

import React, {useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';

import {Colors} from '../components/theme';
import {t, useT} from '../i18n';
import type {MessageKey} from '../i18n/locales/en';
import {alertError, confirmDialog} from '../utils/alert';
import {
  describeRepeat,
  describeSchedule,
  formatDateTime,
} from '../utils/cronSchedule';
import {isCronConflict, useCronStore} from '../store/cron';
import type {CronJob} from '../rpc/types';

/** 状态徽章配色（state 为服务端读侧派生值；未知 state 原样展示）。 */
function stateBadge(state: string): {
  labelKey: MessageKey | null;
  raw: string;
  color: string;
  bg: string;
} {
  switch (state) {
    case 'scheduled':
      return {labelKey: 'cron.stateScheduled', raw: state, color: Colors.success, bg: '#E8F7EE'};
    case 'paused':
      return {labelKey: 'cron.statePaused', raw: state, color: '#FF7D00', bg: '#FFF7E8'};
    case 'completed':
      return {
        labelKey: 'cron.stateCompleted',
        raw: state,
        color: Colors.textSecondary,
        bg: Colors.thinkingBg,
      };
    case 'error':
      return {labelKey: 'cron.stateError', raw: state, color: Colors.danger, bg: Colors.dangerBg};
    default:
      return {
        labelKey: null,
        raw: state,
        color: Colors.textSecondary,
        bg: Colors.thinkingBg,
      };
  }
}

/** last_status 异常徽章（ok 不显示）。 */
function lastStatusBadge(
  status: string,
): {labelKey: MessageKey; color: string} | null {
  switch (status) {
    case 'error':
      return {labelKey: 'cron.statusRunError', color: Colors.danger};
    case 'delivery_failed':
      return {labelKey: 'cron.statusDeliveryFailed', color: '#FF7D00'};
    case 'blocked_config':
      return {labelKey: 'cron.statusBlockedConfig', color: '#FF7D00'};
    default:
      return null;
  }
}

/** 错误明细（优先级：漏触发 > 投递失败 > 运行错误）。 */
function errorDetail(job: CronJob): string | null {
  if (job.last_fire_error?.detail) {
    return t('cron.missedFire', {
      at: formatDateTime(job.last_fire_error.at),
      detail: job.last_fire_error.detail,
    });
  }
  if (job.last_delivery_error) {
    return t('cron.deliveryFailedDetail', {detail: job.last_delivery_error});
  }
  if (job.last_error) {
    return job.last_error;
  }
  return null;
}

/** 顶部打开中的下拉（同时只开一个）。 */
type OpenMenu = 'profile' | null;

/** 分隔线组件提为模块级稳定引用（内联箭头会导致行间线反复重挂）。 */
function RowSeparator() {
  return <View style={styles.sep} />;
}

function DropdownPill({
  label,
  open,
  onPress,
}: {
  label: string;
  open: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.pill, open && styles.pillOpen]}
      onPress={onPress}
      activeOpacity={0.7}>
      <Text style={styles.pillText}>{label}</Text>
      <Text style={[styles.pillCaret, open && styles.pillCaretOpen]}>▾</Text>
    </TouchableOpacity>
  );
}

function MenuOption({
  label,
  selected,
  danger,
  disabled,
  onPick,
}: {
  label: string;
  selected?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onPick: () => void;
}) {
  return (
    <TouchableOpacity
      style={styles.menuItem}
      disabled={disabled}
      activeOpacity={0.6}
      onPress={onPick}>
      <Text
        style={[
          styles.menuItemText,
          selected && styles.menuItemTextActive,
          danger && styles.menuItemTextDanger,
          disabled && styles.menuItemTextDisabled,
        ]}>
        {label}
      </Text>
      {selected ? <Text style={styles.menuItemCheck}>✓</Text> : null}
    </TouchableOpacity>
  );
}

export function CronPanel({
  onCreate,
  onEditJob,
  onOpenRuns,
}: {
  onCreate: () => void;
  onEditJob: (job: CronJob) => void;
  onOpenRuns: (job: CronJob) => void;
}) {
  const t = useT();
  const jobs = useCronStore(s => s.jobs);
  const loading = useCronStore(s => s.loading);
  const error = useCronStore(s => s.error);
  const refresh = useCronStore(s => s.refresh);
  const profileFilter = useCronStore(s => s.profileFilter);
  const setProfileFilter = useCronStore(s => s.setProfileFilter);
  const busyJobIds = useCronStore(s => s.busyJobIds);
  const triggeringJobId = useCronStore(s => s.triggeringJobId);
  const pause = useCronStore(s => s.pause);
  const resume = useCronStore(s => s.resume);
  const trigger = useCronStore(s => s.trigger);
  const remove = useCronStore(s => s.remove);

  const [menuOpen, setMenuOpen] = useState<OpenMenu>(null);
  const [menuTop, setMenuTop] = useState(0);
  /** 行操作菜单（Modal 居中卡片，跨端一致，免行坐标锚定） */
  const [menuJob, setMenuJob] = useState<CronJob | null>(null);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Android 返回键先收下拉/行菜单
  useEffect(() => {
    if (!menuOpen && !menuJob) {
      return;
    }
    if (Platform.OS === 'web') {
      return;
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (menuJob) {
        setMenuJob(null);
      } else {
        setMenuOpen(null);
      }
      return true;
    });
    return () => sub.remove();
  }, [menuOpen, menuJob]);

  const profileOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const j of jobs) {
      if (j.profile && !seen.has(j.profile)) {
        seen.set(j.profile, j.profile_name || j.profile);
      }
    }
    return [...seen.entries()].map(([key, label]) => ({key, label}));
  }, [jobs]);

  const filteredJobs = useMemo(
    () =>
      profileFilter === 'all'
        ? jobs
        : jobs.filter(j => j.profile === profileFilter),
    [jobs, profileFilter],
  );

  const filterLabel =
    profileFilter === 'all'
      ? t('cron.allProfiles')
      : profileOptions.find(o => o.key === profileFilter)?.label ?? profileFilter;

  const doPauseResume = (job: CronJob) => {
    setMenuJob(null);
    const action = job.state === 'paused' ? resume(job) : pause(job);
    action.catch(e =>
      alertError(t('cron.opFailed'), e instanceof Error ? e.message : String(e)),
    );
  };

  const doTrigger = (job: CronJob) => {
    setMenuJob(null);
    trigger(job).catch(e => {
      if (isCronConflict(e)) {
        alertError(t('cron.jobRunning'), t('cron.jobRunningHint'));
      } else {
        alertError(
          t('cron.triggerFailed'),
          e instanceof Error ? e.message : String(e),
        );
      }
    });
  };

  const doRemove = (job: CronJob) => {
    setMenuJob(null);
    void confirmDialog(
      t('cron.deleteTitle'),
      t('cron.deleteConfirm', {name: job.name}),
    ).then(ok => {
      if (!ok) {
        return;
      }
      remove(job).catch(e =>
        alertError(t('cron.deleteFailed'), e instanceof Error ? e.message : String(e)),
      );
    });
  };

  return (
    <View style={styles.container}>
      <View
        style={styles.toolbar}
        onLayout={e =>
          setMenuTop(e.nativeEvent.layout.y + e.nativeEvent.layout.height + 4)
        }>
        <DropdownPill
          label={filterLabel}
          open={menuOpen === 'profile'}
          onPress={() =>
            menuOpen === 'profile' ? setMenuOpen(null) : setMenuOpen('profile')
          }
        />
        <TouchableOpacity
          style={styles.pill}
          activeOpacity={0.7}
          onPress={onCreate}>
          <Text style={styles.pillText}>{t('cron.new')}</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.count}>{t('cron.count', {count: filteredJobs.length})}</Text>
      {loading && filteredJobs.length === 0 ? (
        <ActivityIndicator style={styles.loading} color={Colors.accent} />
      ) : error && filteredJobs.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.error}>{t('cron.loadFailed', {error})}</Text>
          <TouchableOpacity onPress={() => refresh()} style={styles.retryBtn}>
            <Text style={styles.retryText}>{t('cron.retry')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={filteredJobs}
          keyExtractor={j => `${j.profile ?? ''}:${j.id}`}
          refreshing={loading}
          onRefresh={() => refresh()}
          ItemSeparatorComponent={RowSeparator}
          ListEmptyComponent={
            <Text style={styles.empty}>{t('cron.empty')}</Text>
          }
          renderItem={({item}) => (
            <CronJobRow
              job={item}
              showProfile={profileFilter === 'all'}
              busy={!!busyJobIds[item.id]}
              triggering={triggeringJobId === item.id}
              onOpen={() => onEditJob(item)}
              onMenu={() => setMenuJob(item)}
            />
          )}
        />
      )}

      {menuOpen ? (
        <>
          <TouchableWithoutFeedback onPress={() => setMenuOpen(null)}>
            <View style={StyleSheet.absoluteFill} />
          </TouchableWithoutFeedback>
          <View style={[styles.menu, {top: menuTop}]}>
            <MenuOption
              label={t('cron.allProfiles')}
              selected={profileFilter === 'all'}
              onPick={() => {
                setProfileFilter('all');
                setMenuOpen(null);
              }}
            />
            {profileOptions.map(o => (
              <MenuOption
                key={o.key}
                label={o.label}
                selected={profileFilter === o.key}
                onPick={() => {
                  setProfileFilter(o.key);
                  setMenuOpen(null);
                }}
              />
            ))}
          </View>
        </>
      ) : null}

      <MenuJobModal
        job={menuJob}
        triggering={!!menuJob && triggeringJobId === menuJob.id}
        busy={!!menuJob && !!busyJobIds[menuJob.id]}
        onClose={() => setMenuJob(null)}
        onPauseResume={doPauseResume}
        onTrigger={doTrigger}
        onEdit={job => {
          setMenuJob(null);
          onEditJob(job);
        }}
        onRuns={job => {
          setMenuJob(null);
          onOpenRuns(job);
        }}
        onRemove={doRemove}
      />
    </View>
  );
}

/** 行操作菜单（居中 Modal 卡片；触发中禁用立即运行）。 */
function MenuJobModal({
  job,
  triggering,
  busy,
  onClose,
  onPauseResume,
  onTrigger,
  onEdit,
  onRuns,
  onRemove,
}: {
  job: CronJob | null;
  triggering: boolean;
  busy: boolean;
  onClose: () => void;
  onPauseResume: (job: CronJob) => void;
  onTrigger: (job: CronJob) => void;
  onEdit: (job: CronJob) => void;
  onRuns: (job: CronJob) => void;
  onRemove: (job: CronJob) => void;
}) {
  const t = useT();
  return (
    <Modal
      visible={job != null}
      transparent
      animationType="fade"
      onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle} numberOfLines={1}>
              {job?.name || ''}
            </Text>
            {job ? (
              <>
                <MenuOption
                  label={
                    job.state === 'paused'
                      ? t('cron.resumeSchedule')
                      : t('cron.pauseSchedule')
                  }
                  disabled={busy}
                  onPick={() => onPauseResume(job)}
                />
                <MenuOption
                  label={triggering ? t('cron.runningNow') : t('cron.runNow')}
                  disabled={triggering || busy}
                  onPick={() => onTrigger(job)}
                />
                <MenuOption label={t('cron.runs')} onPick={() => onRuns(job)} />
                <MenuOption label={t('common.edit')} onPick={() => onEdit(job)} />
                <MenuOption
                  label={t('common.delete')}
                  danger
                  onPick={() => onRemove(job)}
                />
              </>
            ) : null}
          </View>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

function CronJobRow({
  job,
  showProfile,
  busy,
  triggering,
  onOpen,
  onMenu,
}: {
  job: CronJob;
  showProfile: boolean;
  busy: boolean;
  triggering: boolean;
  onOpen: () => void;
  onMenu: () => void;
}) {
  const t = useT();
  const badge = stateBadge(job.state);
  const status = job.last_status ? lastStatusBadge(job.last_status) : null;
  const detail = errorDetail(job);
  const scheduleText = describeSchedule(job);
  return (
    <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={onOpen}>
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.title} numberOfLines={1}>
            {job.name}
          </Text>
          {busy ? (
            <ActivityIndicator size="small" color={Colors.accent} style={styles.rowSpinner} />
          ) : (
            <Text style={[styles.stateBadge, {color: badge.color, backgroundColor: badge.bg}]}>
              {badge.labelKey ? t(badge.labelKey) : badge.raw}
            </Text>
          )}
          {showProfile && job.profile ? (
            <Text style={styles.profileBadge} numberOfLines={1}>
              {job.profile_name || job.profile}
            </Text>
          ) : null}
          <TouchableOpacity
            style={styles.moreBtn}
            hitSlop={8}
            disabled={triggering}
            onPress={onMenu}>
            {triggering ? (
              <ActivityIndicator size="small" color={Colors.accent} />
            ) : (
              <Text style={styles.moreText}>⋯</Text>
            )}
          </TouchableOpacity>
        </View>
        {status ? (
          <Text style={[styles.statusLine, {color: status.color}]}>
            {t(status.labelKey)}
          </Text>
        ) : null}
        <Text style={styles.schedule} numberOfLines={1}>
          {`${scheduleText} · ${describeRepeat(job.repeat)}`}
        </Text>
        <Text style={styles.times} numberOfLines={1}>
          {t('cron.nextLastRun', {
            next: formatDateTime(job.next_run_at),
            last: formatDateTime(job.last_run_at),
          })}
        </Text>
        {job.prompt ? (
          <Text style={styles.preview} numberOfLines={1}>
            {job.prompt}
          </Text>
        ) : null}
        {detail ? (
          <Text style={styles.errorLine} numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: Colors.card},
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
    marginHorizontal: 12,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.fillSubtle,
    borderRadius: 9,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  pillOpen: {backgroundColor: Colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.fillBorder},
  pillText: {fontSize: 13, color: Colors.text},
  pillCaret: {fontSize: 10, color: Colors.textSecondary, marginLeft: 5},
  pillCaretOpen: {color: Colors.accentDark},
  count: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginHorizontal: 14,
    marginTop: 8,
    marginBottom: 4,
  },
  loading: {marginTop: 48},
  emptyWrap: {alignItems: 'center', marginTop: 48},
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
  sep: {height: StyleSheet.hairlineWidth, backgroundColor: Colors.border, marginLeft: 14},
  menu: {
    position: 'absolute',
    left: 12,
    width: 160,
    backgroundColor: Colors.card,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: {width: 0, height: 4},
    elevation: 3,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  menuItemText: {fontSize: 14, color: Colors.text, flex: 1},
  menuItemTextActive: {color: Colors.accentDark, fontWeight: '600'},
  menuItemCheck: {fontSize: 14, color: Colors.accent, marginLeft: 8},
  menuItemTextDanger: {color: Colors.danger},
  menuItemTextDisabled: {color: Colors.textSecondary},
  // 行操作菜单 Modal 卡
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCard: {
    width: 220,
    backgroundColor: Colors.card,
    borderRadius: 12,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  modalTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textSecondary,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
    marginBottom: 4,
  },
  row: {
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  rowBody: {flex: 1},
  rowTop: {flexDirection: 'row', alignItems: 'center'},
  rowSpinner: {marginLeft: 6},
  title: {fontSize: 15, fontWeight: '500', color: Colors.text, flexShrink: 1},
  stateBadge: {
    fontSize: 10,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    marginLeft: 6,
    overflow: 'hidden',
  },
  profileBadge: {
    fontSize: 10,
    color: Colors.accentDark,
    backgroundColor: '#E8F7FF',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    marginLeft: 6,
    flexShrink: 1,
  },
  moreBtn: {marginLeft: 8, paddingHorizontal: 4},
  moreText: {fontSize: 16, color: Colors.textSecondary},
  statusLine: {fontSize: 12, marginTop: 3},
  schedule: {fontSize: 13, color: Colors.text, marginTop: 3},
  times: {fontSize: 12, color: Colors.textSecondary, marginTop: 2},
  preview: {fontSize: 13, color: Colors.textSecondary, marginTop: 2},
  errorLine: {fontSize: 12, color: Colors.danger, marginTop: 3},
});
