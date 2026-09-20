/**
 * mdSourceMap — markdown 源码行号映射（web 端「拖选复制源码」核心）。
 *
 * markdown-it 的块级 token 自带 map: [startLine, endLine)（文档级行号，
 * end 不含），渲染成 HTML 后该信息默认丢失。injectSrcMapRule 把它注入
 * data-md-map 属性，copy 拦截时据此把「选区覆盖的渲染块」映射回源码行
 * 范围（块级粒度：不会复制出半截表格/列表）。
 */

import type MarkdownIt from 'markdown-it';

type MarkdownItInstance = InstanceType<typeof MarkdownIt>;

/** 给带 map 的块级 token 注入 data-md-map="start:end"（行号，end 不含）。 */
export function injectSrcMapRule(md: MarkdownItInstance): void {
  md.core.ruler.push('hermes_src_map', state => {
    for (const token of state.tokens) {
      // close token 无 map；inline 的 attr 不会出现在 HTML 标签上，都跳过
      if (token.map && (token.nesting === 1 || (token.nesting === 0 && token.type !== 'inline'))) {
        token.attrSet('data-md-map', `${token.map[0]}:${token.map[1]}`);
      }
    }
  });
}

/** 源码行范围（start 含 / end 不含，与 markdown-it token.map 同约定）。 */
export interface LineRange {
  start: number;
  end: number;
}

/** 多个行范围取并集的外包（选区覆盖多个块时合并为一段连续源码）。 */
export function unionLineRange(
  ranges: LineRange[],
): LineRange | null {
  if (ranges.length === 0) {
    return null;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of ranges) {
    lo = Math.min(lo, r.start);
    hi = Math.max(hi, r.end);
  }
  return {start: lo, end: hi};
}

/** 丢弃被其他范围完整包含（或与之完全等同的后发项），只留最外层块。 */
export function outermostRanges(ranges: LineRange[]): LineRange[] {
  return ranges.filter(
    (r, i) =>
      !ranges.some(
        (other, j) =>
          j !== i &&
          other.start <= r.start &&
          other.end >= r.end &&
          // 严格包含必丢；完全等同（如 blockquote 与其内 p 同 map）只留先出现者
          (other.start < r.start || other.end > r.end || j < i),
      ),
  );
}

/** 归一化（trim + 连续空白折叠为单个空格）后比较，判定选区是否覆盖整块文本。 */
export function isWholeBlockSelected(
  selectedText: string,
  blockText: string,
): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const sel = norm(selectedText);
  return sel.length > 0 && sel === norm(blockText);
}

/** 按行号范围从源文本切片（越界自动收敛，空范围返回空串）。 */
export function sliceSourceLines(
  text: string,
  startLine: number,
  endLine: number,
): string {
  const lines = text.split('\n');
  const lo = Math.max(0, startLine);
  const hi = Math.min(lines.length, endLine);
  return hi <= lo ? '' : lines.slice(lo, hi).join('\n');
}

/** 解析 data-md-map 属性值（"start:end"），非法格式返回 null。 */
export function parseMapAttr(value: string | null): LineRange | null {
  if (!value) {
    return null;
  }
  const parts = value.split(':');
  if (parts.length !== 2) {
    return null;
  }
  const start = Number(parts[0]);
  const end = Number(parts[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
    return null;
  }
  return {start, end};
}
