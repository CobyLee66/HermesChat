import React, {useMemo, useState} from 'react';
import {Platform, ScrollView, StyleSheet, View} from 'react-native';
import Markdown from 'react-native-markdown-display';

import {Colors} from './theme';
import {rewriteListMarkers} from '../utils/markdownLists';

interface Props {
  text: string;
}

/**
 * 助手消息的 markdown 渲染（react-native-markdown-display）。
 * - 列表标记在渲染前改写为普通文本前缀（见 utils/markdownLists.ts）：
 *   库的 bullet_list 布局在安卓端会把气泡压缩成窄竖条，改写成普通段落
 *   后按已验证宽度正常的路径渲染；
 * - 表格用自定义 rule 包一层横向 ScrollView：列宽随内容（flexShrink:0），
 *   窄表至少撑满气泡内容宽（minWidth），宽表可左右滑动；
 * - 链接沿用库默认行为（系统浏览器打开）；
 * - 文本选择复制由 Bubble 长按菜单接管（全选/部分选择），这里不做 selectable
 *   —— RN 的 Text 选择按单个控件走，跨段落/表格会断，交给整条纯文本。
 */
export function MarkdownText({text}: Props) {
  // 量取气泡内容宽度，作为表格的最小宽度基准
  const [width, setWidth] = useState(0);
  // 列表标记改写（纯文本变换，随消息稳定）
  const content = useMemo(() => rewriteListMarkers(text), [text]);
  const rules = useMemo(
    () => ({
      // eslint-disable-next-line react/no-unstable-nested-components -- 库的渲染规则是 render prop，非常驻组件
      table: (node: {key: string}, children: React.ReactNode) => (
        <ScrollView
          key={node.key}
          horizontal
          style={styles.tableScroll}
          showsHorizontalScrollIndicator>
          <View style={[mdStyles.table, width > 0 ? {minWidth: width} : null]}>
            {children}
          </View>
        </ScrollView>
      ),
    }),
    [width],
  );
  return (
    <View
      onLayout={e => {
        const w = e.nativeEvent.layout.width;
        if (w > 0 && w !== width) {
          setWidth(w);
        }
      }}>
      <Markdown style={mdStyles} rules={rules}>
        {content}
      </Markdown>
    </View>
  );
}

const mono = Platform.select({ios: 'Courier', android: 'monospace'});

/** 覆盖库默认样式（按元素名整键替换），配色对齐浅色 QQ 风主题。 */
const mdStyles = StyleSheet.create({
  body: {fontSize: 16, lineHeight: 23, color: Colors.text},
  heading1: {fontSize: 24, fontWeight: '700', marginVertical: 6},
  heading2: {fontSize: 20, fontWeight: '700', marginVertical: 5},
  heading3: {fontSize: 17, fontWeight: '600', marginVertical: 4},
  heading4: {fontSize: 16, fontWeight: '600', marginVertical: 3},
  heading5: {fontSize: 14, fontWeight: '600', marginVertical: 2},
  heading6: {fontSize: 13, fontWeight: '600', marginVertical: 2},
  hr: {backgroundColor: Colors.border, height: StyleSheet.hairlineWidth},
  strong: {fontWeight: '700'},
  em: {fontStyle: 'italic'},
  s: {textDecorationLine: 'line-through'},
  link: {color: Colors.accentDark},
  blockquote: {
    backgroundColor: Colors.thinkingBg,
    borderColor: Colors.border,
    borderLeftWidth: 3,
    paddingHorizontal: 8,
  },
  bullet_list: {marginVertical: 2},
  ordered_list: {marginVertical: 2},
  list_item: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    marginVertical: 1,
  },
  bullet_list_icon: {marginLeft: 6, marginRight: 8},
  bullet_list_content: {flex: 1},
  ordered_list_icon: {marginLeft: 6, marginRight: 8},
  ordered_list_content: {flex: 1},
  code_inline: {
    backgroundColor: Colors.thinkingBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    borderRadius: 4,
    paddingHorizontal: 4,
    fontFamily: mono,
    fontSize: 14,
  },
  code_block: {
    backgroundColor: Colors.thinkingBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    borderRadius: 8,
    padding: 10,
    fontFamily: mono,
    fontSize: 13,
    lineHeight: 19,
  },
  fence: {
    backgroundColor: Colors.thinkingBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    borderRadius: 8,
    padding: 10,
    fontFamily: mono,
    fontSize: 13,
    lineHeight: 19,
  },
  table: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    borderRadius: 6,
    marginVertical: 6,
  },
  thead: {backgroundColor: Colors.thinkingBg},
  tbody: {},
  tr: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  /** 列宽随内容、不压缩（flexShrink:0），超出气泡宽度时整体横向滚动 */
  th: {
    flexShrink: 0,
    minWidth: 72,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  td: {
    flexShrink: 0,
    minWidth: 72,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
});

const styles = StyleSheet.create({
  tableScroll: {marginVertical: 2},
});
