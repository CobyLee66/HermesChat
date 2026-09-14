import React, {useMemo, useState} from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';

import {
  countDiffStats,
  fileEditPath,
  parseDiffLines,
  type DiffLine,
} from '../rpc/diffText';
import {useT} from '../i18n';
import {expandToggleProps} from '../utils/expandPress';
import type {ToolCallBlock} from '../rpc/types';
import {Colors} from './theme';

interface Props {
  tool: ToolCallBlock;
}

function argsPreview(args: Record<string, unknown> | undefined): string {
  if (!args) {
    return '';
  }
  try {
    const s = JSON.stringify(args);
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  } catch {
    return '';
  }
}

/** 单条 diff 行渲染上限（服务端 inline_diff 本身截到 80 行，兜底防大 diff）。 */
const MAX_DIFF_LINES = 300;

/**
 * 变更 diff 面板：unified diff 解析成行级红/绿/弱化块（对齐 hermes web
 * dashboard 的展示口径——+/- 行着色、@@ 与文件头弱化、行首保留 +/- 标记）。
 */
function DiffPanel({diff}: {diff: string}) {
  const t = useT();
  const lines = useMemo(() => {
    const parsed = parseDiffLines(diff);
    return parsed.length > MAX_DIFF_LINES
      ? [
          ...parsed.slice(0, MAX_DIFF_LINES),
          {
            kind: 'context' as const,
            text: t('chat.diffTruncated', {count: parsed.length}),
          },
        ]
      : parsed;
  }, [diff, t]);
  return (
    <View style={styles.diffWrap}>
      {lines.map((line, i) => (
        <DiffRow key={i} line={line} />
      ))}
    </View>
  );
}

function diffRowStyle(kind: DiffLine['kind']) {
  switch (kind) {
    case 'add':
      return {bg: styles.diffAdd, mark: styles.diffAddMark, text: null};
    case 'remove':
      return {bg: styles.diffRemove, mark: styles.diffRemoveMark, text: null};
    default:
      return {bg: null, mark: styles.diffMark, text: styles.diffMetaText};
  }
}

function DiffRow({line}: {line: DiffLine}) {
  const s = diffRowStyle(line.kind);
  const mark =
    line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : line.kind === 'meta' ? '' : ' ';
  return (
    <View style={[styles.diffRow, s.bg]}>
      <Text style={[styles.diffMarkBase, s.mark]}>{mark}</Text>
      <Text style={[styles.diffLineText, s.text]} numberOfLines={1}>
        {line.text || ' '}
      </Text>
    </View>
  );
}

/** 工具调用卡片：名称 + 参数预览 + 状态；点击展开 args / result / diff。 */
export function ToolCallCard({tool}: Props) {
  const [expanded, setExpanded] = useState(false);
  const t = useT();
  const running = tool.status === 'running';
  const title = tool.context || argsPreview(tool.args);
  const diff = tool.inlineDiff;
  const stats = useMemo(
    () => (diff && !running ? countDiffStats(diff) : null),
    [diff, running],
  );
  const showStats = !!stats && (stats.added > 0 || stats.removed > 0);
  // 有格式化 diff 时隐藏 raw result（重复且难读）；文件编辑工具折叠头
  // 优先显示文件路径（比 80 字 args 预览可读）
  const filePath = fileEditPath(tool.args);
  const subtitle = diff && filePath ? filePath : title;
  return (
    <View style={styles.card}>
      <TouchableOpacity
        {...expandToggleProps(() => setExpanded(v => !v))}
        activeOpacity={0.7}
        style={styles.headerRow}>
        <Text style={styles.icon}>{running ? '⏳' : diff ? '📝' : '🔧'}</Text>
        <View style={styles.headerTextWrap}>
          <View style={styles.nameRow}>
            <Text style={styles.name}>
              {tool.name}
              {typeof tool.durationS === 'number'
                ? `  ${tool.durationS.toFixed(1)}s`
                : ''}
            </Text>
            {showStats && stats ? (
              <Text style={styles.stats}>
                <Text style={styles.statsAdd}>+{stats.added}</Text>
                {'  '}
                <Text style={styles.statsRemove}>−{stats.removed}</Text>
              </Text>
            ) : null}
          </View>
          {subtitle ? (
            <Text
              style={[styles.context, diff ? styles.contextMono : null]}
              numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
          {running && tool.progress ? (
            <Text style={styles.progress} numberOfLines={1}>
              {tool.progress}
            </Text>
          ) : null}
        </View>
        <Text style={styles.chevron}>{expanded ? '▾' : '▸'}</Text>
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.detail}>
          {tool.summary ? <Text style={styles.summary}>{tool.summary}</Text> : null}
          {diff ? <DiffPanel diff={diff} /> : null}
          {tool.args && Object.keys(tool.args).length > 0 ? (
            <>
              <Text style={styles.sectionTitle}>{t('tool.args')}</Text>
              <Text style={styles.mono}>{JSON.stringify(tool.args, null, 2)}</Text>
            </>
          ) : null}
          {!diff && tool.result ? (
            <>
              <Text style={styles.sectionTitle}>{t('tool.result')}</Text>
              <Text style={styles.mono} numberOfLines={60}>
                {tool.result.length > 4000
                  ? tool.result.slice(0, 4000) + t('chat.outputTruncated')
                  : tool.result}
              </Text>
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 4,
    backgroundColor: Colors.thinkingBg,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  icon: {fontSize: 13, marginRight: 6},
  headerTextWrap: {flex: 1},
  nameRow: {flexDirection: 'row', alignItems: 'center'},
  name: {fontSize: 13, fontWeight: '600', color: Colors.text},
  stats: {fontSize: 11, marginLeft: 8, fontFamily: 'monospace' as never},
  statsAdd: {color: Colors.diffAddText},
  statsRemove: {color: Colors.diffRemoveText},
  context: {fontSize: 12, color: Colors.textSecondary, marginTop: 1},
  contextMono: {fontFamily: 'monospace' as never},
  progress: {fontSize: 12, color: Colors.accent, marginTop: 1},
  chevron: {fontSize: 12, color: Colors.textSecondary, marginLeft: 6},
  detail: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  summary: {fontSize: 12, color: Colors.text, marginBottom: 4},
  sectionTitle: {
    fontSize: 11,
    color: Colors.textSecondary,
    marginTop: 6,
    marginBottom: 2,
  },
  mono: {
    fontSize: 11,
    color: Colors.text,
    fontFamily: 'monospace' as never,
  },
  // ─── diff 面板 ───────────────────────────────────────────
  diffWrap: {
    backgroundColor: Colors.card,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    paddingVertical: 4,
    marginTop: 2,
  },
  diffRow: {flexDirection: 'row', paddingHorizontal: 0},
  diffAdd: {backgroundColor: Colors.diffAddBg},
  diffRemove: {backgroundColor: Colors.diffRemoveBg},
  diffMarkBase: {
    width: 14,
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    fontFamily: 'monospace' as never,
    fontWeight: '700',
  },
  diffMark: {color: Colors.diffMetaText},
  diffAddMark: {color: Colors.diffAddText},
  diffRemoveMark: {color: Colors.diffRemoveText},
  diffLineText: {
    flex: 1,
    fontSize: 11,
    lineHeight: 16,
    fontFamily: 'monospace' as never,
    color: Colors.text,
  },
  diffMetaText: {color: Colors.diffMetaText},
});
