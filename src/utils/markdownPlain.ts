import MarkdownIt from 'markdown-it';

const md = new MarkdownIt();

/** markdown-it Token 的宽松子集（够 plainify 用即可） */
interface LooseTok {
  type?: string;
  content?: string;
  children?: LooseTok[] | null;
}

/**
 * markdown 源码 → 便于复制/展示的纯文本。
 * 只收集可见字符：去掉 #、*、`、>、| 等语法记号；表格单元格用 \t 分隔
 * （贴到表格软件可直接分列），每行一段。供气泡「全选复制 / 部分选择」使用。
 */
export function markdownToPlain(src: string): string {
  if (!src) {
    return '';
  }
  const tokens = md.parse(src, {}) as LooseTok[];
  const lines: string[] = [];
  let cur = '';

  const flush = () => {
    const t = cur.replace(/\s+$/g, '');
    if (t) {
      lines.push(t);
    }
    cur = '';
  };

  const walkInline = (t: LooseTok) => {
    if (!t.children) {
      if (t.content) {
        cur += t.content;
      }
      return;
    }
    for (const c of t.children) {
      if (c.type === 'text' || c.type === 'code_inline') {
        cur += c.content ?? '';
      } else if (c.type === 'softbreak' || c.type === 'hardbreak') {
        cur += '\n';
      } else {
        walkInline(c);
      }
    }
  };

  // 块开始/结束标记：需要换行收尾
  const HARD_END = new Set([
    'paragraph_close',
    'heading_close',
    'list_item_close',
    'blockquote_close',
    'fence',
    'code_block',
    'table_close',
    'thead_close',
    'tbody_close',
    'tr_close',
    'hr',
  ]);

  for (const t of tokens) {
    if (t.type === 'inline') {
      walkInline(t);
      continue;
    }
    if (t.type === 'fence' || t.type === 'code_block') {
      flush();
      if (t.content) {
        lines.push(t.content.replace(/\n+$/, ''));
      }
      continue;
    }
    if (t.type === 'th_open' || t.type === 'td_open') {
      // 单元格之间用制表符分隔（新起 cell 时若 cur 非空先补一个）
      cur = cur.replace(/\s+$/g, '');
      if (cur) {
        cur += '\t';
      }
      continue;
    }
    if (t.type === 'tr_open') {
      flush();
      continue;
    }
    if (t.type === 'hr') {
      flush();
      continue;
    }
    if (t.type && HARD_END.has(t.type)) {
      flush();
    }
  }
  flush();
  return lines.join('\n');
}
