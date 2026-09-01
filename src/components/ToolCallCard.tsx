import React, {useState} from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';

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

/** 工具调用卡片：名称 + 参数预览 + 状态；点击展开 args / result / diff。 */
export function ToolCallCard({tool}: Props) {
  const [expanded, setExpanded] = useState(false);
  const running = tool.status === 'running';
  const title = tool.context || argsPreview(tool.args);
  return (
    <View style={styles.card}>
      <TouchableOpacity
        onPress={() => setExpanded(v => !v)}
        activeOpacity={0.7}
        style={styles.headerRow}>
        <Text style={styles.icon}>{running ? '⏳' : '🔧'}</Text>
        <View style={styles.headerTextWrap}>
          <Text style={styles.name}>
            {tool.name}
            {typeof tool.durationS === 'number'
              ? `  ${tool.durationS.toFixed(1)}s`
              : ''}
          </Text>
          {title ? (
            <Text style={styles.context} numberOfLines={expanded ? undefined : 1}>
              {title}
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
          {tool.args && Object.keys(tool.args).length > 0 ? (
            <>
              <Text style={styles.sectionTitle}>参数</Text>
              <Text style={styles.mono}>{JSON.stringify(tool.args, null, 2)}</Text>
            </>
          ) : null}
          {tool.inlineDiff ? (
            <>
              <Text style={styles.sectionTitle}>变更</Text>
              <Text style={styles.mono}>{tool.inlineDiff}</Text>
            </>
          ) : null}
          {tool.result ? (
            <>
              <Text style={styles.sectionTitle}>结果</Text>
              <Text style={styles.mono} numberOfLines={60}>
                {tool.result.length > 4000
                  ? tool.result.slice(0, 4000) + '\n…（截断）'
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
  name: {fontSize: 13, fontWeight: '600', color: Colors.text},
  context: {fontSize: 12, color: Colors.textSecondary, marginTop: 1},
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
});
