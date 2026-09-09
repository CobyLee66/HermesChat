/**
 * SessionListPanel — 会话列表面板（工具栏（筛选/排序双下拉）+ 列表 + 行 + 空态）。
 * 手机 SessionListScreen 与桌面会话列共用；导航差异通过 onOpenSession/
 * onNewSession 回调注入。zustand 选择器返回稳定引用（EMPTY 常量约定）。
 */

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  BackHandler,
  FlatList,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';

import {Avatar} from '../components/Avatar';
import {Colors} from '../components/theme';
import {useProfilesStore} from '../store/profiles';
import {useSessionsStore} from '../store/sessions';
import {alertError} from '../utils/alert';
import {
  automationSourceLabel,
  isAutomationSource,
  sourceBelongsToCategory,
  type SessionFilterCategory,
} from '../utils/sessionSources';
import {sortSessionRows, type SessionSortMode} from '../utils/sessionSort';
import type {SessionListRow} from '../rpc/types';
import {deleteSessionFlow, openSessionFlow, type OpenedSession} from './sessionFlows';

const EMPTY_SESSIONS: SessionListRow[] = [];

/** 会话行右键坐标（视口坐标，桌面弹菜单定位用） */
export interface RowContextMenuPos {
  x: number;
  y: number;
}

/** 宿主节点的最小监听能力面（web 下 RNW TouchableOpacity ref 即 DOM 节点） */
interface RowHostNode {
  addEventListener?: (type: string, listener: (e: unknown) => void) => void;
  removeEventListener?: (type: string, listener: (e: unknown) => void) => void;
}

/** web 右键原生事件里用到的字段（无 DOM lib：结构类型） */
interface ContextMenuEventLike {
  clientX?: number;
  clientY?: number;
  preventDefault?: () => void;
}

const FILTER_OPTIONS: {key: SessionFilterCategory; label: string}[] = [
  {key: 'chats', label: '聊天'},
  {key: 'automation', label: '自动化'},
  {key: 'all', label: '全部'},
];

const SORT_OPTIONS: {key: SessionSortMode; label: string}[] = [
  {key: 'recent', label: '最近消息'},
  {key: 'created', label: '创建时间'},
];

/** 顶部打开中的下拉（同时只开一个） */
type OpenMenu = 'filter' | 'sort' | null;

/** 分隔线组件提为模块级稳定引用：内联箭头函数每次 render 换组件类型，行间线反复重挂 */
function RowSeparator() {
  return <View style={styles.sep} />;
}

/** 工具栏下拉药丸（当前值 + ▾ 指示，文本字符沿用「‹ 返回」「⋯」惯例） */
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

/** 下拉菜单选项行（选中项 accent 色 + ✓，ModelPicker 同款选中态） */
function MenuOption({
  label,
  selected,
  onPick,
}: {
  label: string;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <TouchableOpacity style={styles.menuItem} activeOpacity={0.6} onPress={onPick}>
      <Text style={[styles.menuItemText, selected && styles.menuItemTextActive]}>
        {label}
      </Text>
      {selected ? <Text style={styles.menuItemCheck}>✓</Text> : null}
    </TouchableOpacity>
  );
}

function formatTime(ts: number): string {
  if (!ts) {
    return '';
  }
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** profile 昵称（ui_meta.nickname > description > name），列表行头像/标题用。 */
export function useProfileNickname(profile: string): string {
  const profileInfo = useProfilesStore(s => s.list.find(p => p.name === profile));
  return (
    (profileInfo?.ui_meta as {nickname?: string} | undefined)?.nickname ||
    profileInfo?.description ||
    profile
  );
}

export function SessionListPanel({
  profile,
  onOpenSession,
  refreshTrigger,
  onRowContextMenu,
}: {
  profile: string;
  onOpenSession: (opened: OpenedSession) => void;
  /** 外部请求刷新（桌面切 profile 等）；内容变化即触发，传值比较 */
  refreshTrigger?: number;
  /** 桌面右键会话行（web 专用；手机不传，长按删除行为不变） */
  onRowContextMenu?: (row: SessionListRow, pos: RowContextMenuPos) => void;
}) {
  const nicknameText = useProfileNickname(profile);
  const avatarUri = useProfilesStore(s => s.avatars[profile]);
  const sessions = useSessionsStore(s => s.byProfile[profile] ?? EMPTY_SESSIONS);
  const refresh = useSessionsStore(s => s.refresh);
  const sortMode = useSessionsStore(s => s.sortMode);
  const setSortMode = useSessionsStore(s => s.setSortMode);
  const [filter, setFilter] = useState<SessionFilterCategory>('chats');
  const [menuOpen, setMenuOpen] = useState<OpenMenu>(null);
  // 菜单锚点：工具栏在容器内的底边 y（onLayout 实测，免疫字体缩放导致的行高变化）
  const [menuTop, setMenuTop] = useState(0);

  // 面板挂载/切换 profile 时刷新（原屏幕 effect 行为保持）；顺手收起下拉
  React.useEffect(() => {
    setMenuOpen(null);
    refresh(profile);
  }, [refresh, profile, refreshTrigger]);

  // Android 硬件返回键先关下拉，不退出页面（web 无此能力，自然跳过）
  React.useEffect(() => {
    if (!menuOpen || Platform.OS === 'web') {
      return;
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setMenuOpen(null);
      return true;
    });
    return () => sub.remove();
  }, [menuOpen]);

  const filterLabel =
    FILTER_OPTIONS.find(f => f.key === filter)?.label ?? filter;
  const sortLabel = SORT_OPTIONS.find(o => o.key === sortMode)?.label ?? sortMode;

  const filteredSessions = useMemo(
    () =>
      sortSessionRows(
        sessions.filter(s => sourceBelongsToCategory(s.source, filter)),
        sortMode,
      ),
    [sessions, filter, sortMode],
  );

  const openSession = useCallback(
    async (row: SessionListRow) => {
      try {
        const opened = await openSessionFlow(profile, row);
        onOpenSession(opened);
      } catch (e) {
        alertError('打开会话失败', e instanceof Error ? e.message : String(e));
      }
    },
    [onOpenSession, profile],
  );

  const onDelete = useCallback(
    (sessionId: string, title: string) => {
      void deleteSessionFlow(profile, sessionId, title);
    },
    [profile],
  );

  return (
    <View style={styles.container}>
      <View
        style={styles.toolbar}
        onLayout={e =>
          setMenuTop(e.nativeEvent.layout.y + e.nativeEvent.layout.height + 4)
        }>
        <DropdownPill
          label={filterLabel}
          open={menuOpen === 'filter'}
          onPress={() =>
            setMenuOpen(open => (open === 'filter' ? null : 'filter'))
          }
        />
        <DropdownPill
          label={sortLabel}
          open={menuOpen === 'sort'}
          onPress={() => setMenuOpen(open => (open === 'sort' ? null : 'sort'))}
        />
      </View>
      <FlatList
        data={filteredSessions}
        keyExtractor={s => s.id}
        refreshing={false}
        onRefresh={() => refresh(profile, true)}
        ItemSeparatorComponent={RowSeparator}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {sessions.length === 0
              ? '还没有会话，点「新会话」开始'
              : '该分类下暂无会话'}
          </Text>
        }
        renderItem={({item}) => (
          <SessionRow
            item={item}
            avatarName={nicknameText}
            avatarUri={avatarUri}
            showActivityTime={sortMode === 'recent'}
            onOpen={openSession}
            onDelete={onDelete}
            onRowContextMenu={onRowContextMenu}
          />
        )}
      />
      {menuOpen ? (
        <>
          {/* 点菜单外任意处收起（顺带挡住列表触摸）；absoluteFill 铺满面板 */}
          <TouchableWithoutFeedback onPress={() => setMenuOpen(null)}>
            <View style={StyleSheet.absoluteFill} />
          </TouchableWithoutFeedback>
          {/* 锚定在对应药丸正下方：left/right 与工具栏边距对齐，零坐标换算 */}
          <View
            style={[
              styles.menu,
              menuOpen === 'filter' ? styles.menuFilter : styles.menuSort,
              {top: menuTop},
            ]}>
            {menuOpen === 'filter'
              ? FILTER_OPTIONS.map(f => (
                  <MenuOption
                    key={f.key}
                    label={f.label}
                    selected={filter === f.key}
                    onPick={() => {
                      setFilter(f.key);
                      setMenuOpen(null);
                    }}
                  />
                ))
              : SORT_OPTIONS.map(o => (
                  <MenuOption
                    key={o.key}
                    label={o.label}
                    selected={sortMode === o.key}
                    onPick={() => {
                      setSortMode(o.key);
                      setMenuOpen(null);
                    }}
                  />
                ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

/** 单行会话（hook 独立成组件，避免循环内调用）。 */
function SessionRow({
  item,
  avatarName,
  avatarUri,
  showActivityTime,
  onOpen,
  onDelete,
  onRowContextMenu,
}: {
  item: SessionListRow;
  avatarName: string;
  avatarUri?: string;
  /** 「最近消息」档展示行活跃时间（缺失回退创建时间）；创建时间档展示 started_at */
  showActivityTime: boolean;
  onOpen: (row: SessionListRow) => void;
  onDelete: (sessionId: string, title: string) => void;
  onRowContextMenu?: (row: SessionListRow, pos: RowContextMenuPos) => void;
}) {
  // web 右键：直接在宿主节点挂原生监听（React 的 onContextMenu 委托在
  // 本项目 web 环境实测不派发）；原生端无该能力，effect 内自然跳过
  const hostRef = useRef<RowHostNode | null>(null);
  useEffect(() => {
    if (!onRowContextMenu) {
      return;
    }
    const host = hostRef.current;
    if (!host?.addEventListener || !host?.removeEventListener) {
      return;
    }
    const handler = (raw: unknown) => {
      const e = raw as ContextMenuEventLike;
      e.preventDefault?.();
      onRowContextMenu(item, {x: e.clientX ?? 0, y: e.clientY ?? 0});
    };
    host.addEventListener('contextmenu', handler);
    return () => {
      host.removeEventListener?.('contextmenu', handler);
    };
  }, [item, onRowContextMenu]);

  return (
    <TouchableOpacity
      ref={node => {
        hostRef.current = node as unknown as RowHostNode | null;
      }}
      style={styles.row}
      activeOpacity={0.7}
      onPress={() => onOpen(item)}
      onLongPress={() => onDelete(item.id, item.title)}>
      <Avatar name={avatarName} uri={avatarUri} size={42} />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.title} numberOfLines={1}>
            {item.title || '未命名会话'}
          </Text>
          {item.namespaced ? <Text style={styles.nsBadge}>QQ</Text> : null}
          {isAutomationSource(item.source) ? (
            <Text style={styles.sourceBadge}>
              {automationSourceLabel(item.source)}
            </Text>
          ) : null}
          <Text style={styles.time}>
            {formatTime(
              showActivityTime ? item.last_active || item.started_at : item.started_at,
            )}
          </Text>
        </View>
        <Text style={styles.preview} numberOfLines={1}>
          {item.preview || `${item.message_count} 条消息`}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: Colors.card},
  // 单行工具栏：筛选下拉靠左、排序下拉靠右
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
    marginHorizontal: 12,
    marginBottom: 8,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.fill,
    borderRadius: 9,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
  },
  pillOpen: {backgroundColor: Colors.card, borderColor: Colors.fillBorder},
  pillText: {fontSize: 13, color: Colors.text},
  pillCaret: {fontSize: 10, color: Colors.textSecondary, marginLeft: 5},
  pillCaretOpen: {color: Colors.accentDark},
  // 下拉菜单卡：锚定对应药丸正下方（SlashSuggest 同款阴影）
  menu: {
    position: 'absolute',
    width: 148,
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
  menuFilter: {left: 12},
  menuSort: {right: 12},
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  menuItemText: {fontSize: 14, color: Colors.text, flex: 1},
  menuItemTextActive: {color: Colors.accentDark, fontWeight: '600'},
  menuItemCheck: {fontSize: 14, color: Colors.accent, marginLeft: 8},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  rowBody: {flex: 1, marginLeft: 12},
  rowTop: {flexDirection: 'row', alignItems: 'center'},
  title: {fontSize: 15, fontWeight: '500', color: Colors.text, flex: 1},
  nsBadge: {
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
  sourceBadge: {
    fontSize: 10,
    color: Colors.accentDark,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.accent,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    marginLeft: 6,
    overflow: 'hidden',
  },
  time: {fontSize: 11, color: Colors.textSecondary, marginLeft: 8},
  preview: {fontSize: 13, color: Colors.textSecondary, marginTop: 2},
  sep: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.border,
    marginLeft: 68,
  },
  empty: {
    textAlign: 'center',
    color: Colors.textSecondary,
    marginTop: 60,
    fontSize: 14,
  },
});
