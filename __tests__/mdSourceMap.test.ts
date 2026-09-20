/** mdSourceMap：markdown-it 源行注入与切片纯函数（web「拖选复制源码」核心）。 */

import MarkdownIt from 'markdown-it';

import {
  injectSrcMapRule,
  isWholeBlockSelected,
  outermostRanges,
  parseMapAttr,
  sliceSourceLines,
  unionLineRange,
} from '../src/utils/mdSourceMap';

function render(src: string): string {
  const md = new MarkdownIt({linkify: true, breaks: false});
  injectSrcMapRule(md);
  return md.render(src);
}

describe('injectSrcMapRule：块级 token 注入 data-md-map', () => {
  it('标题/段落/代码块标注文档级行号（end 不含）', () => {
    const html = render('# 标题\n\n段落一文字\n\n```js\nconst a = 1;\n```\n');
    expect(html).toContain('<h1 data-md-map="0:1"');
    expect(html).toContain('<p data-md-map="2:3"');
    // fence 的属性落在内部 <code> 标签上：```js 起始 line4，块后一行 line7
    expect(html).toContain('<code data-md-map="4:7"');
  });

  it('表格/列表的嵌套块各级都带行号', () => {
    const html = render('| a | b |\n|---|---|\n| 1 | 2 |\n\n- 列表一\n- 列表二\n');
    expect(html).toContain('<table data-md-map="0:3"');
    expect(html).toContain('<tbody data-md-map="2:3"');
    expect(html).toContain('<ul data-md-map="4:6"');
    expect(html).toContain('<li data-md-map="4:5"');
    expect(html).toContain('<li data-md-map="5:6"');
  });

  it('引用/行内格式段落映射回源行', () => {
    const html = render('> 引用内容\n\n**加粗**与`code`混排\n');
    expect(html).toContain('<blockquote data-md-map="0:1"');
    expect(html).toContain('<p data-md-map="2:3"');
  });

  it('close token 与 inline 不产生属性', () => {
    const html = render('# 标\n');
    expect(html).not.toContain('</h1 ');
    expect(html).toMatch(/<\/h1>/);
  });
});

describe('sliceSourceLines', () => {
  const text = 'l0\nl1\nl2\nl3';

  it('按 [start, end) 切片', () => {
    expect(sliceSourceLines(text, 1, 3)).toBe('l1\nl2');
  });

  it('end 越界收敛到末行', () => {
    expect(sliceSourceLines(text, 2, 99)).toBe('l2\nl3');
  });

  it('start 为负从 0 起', () => {
    expect(sliceSourceLines(text, -5, 1)).toBe('l0');
  });

  it('空范围返回空串', () => {
    expect(sliceSourceLines(text, 2, 2)).toBe('');
    expect(sliceSourceLines(text, 3, 1)).toBe('');
    expect(sliceSourceLines('', 0, 1)).toBe('');
  });
});

describe('unionLineRange', () => {
  it('空数组返回 null', () => {
    expect(unionLineRange([])).toBeNull();
  });

  it('取最小 start 与最大 end 的外包', () => {
    expect(unionLineRange([{start: 4, end: 5}, {start: 2, end: 3}])).toEqual({
      start: 2,
      end: 5,
    });
  });
});

describe('outermostRanges', () => {
  it('丢弃被完整包含的项（li 里的 p）', () => {
    expect(
      outermostRanges([
        {start: 4, end: 6},
        {start: 4, end: 5},
      ]),
    ).toEqual([{start: 4, end: 6}]);
  });

  it('并列范围都保留', () => {
    expect(
      outermostRanges([
        {start: 0, end: 1},
        {start: 2, end: 3},
      ]),
    ).toEqual([
      {start: 0, end: 1},
      {start: 2, end: 3},
    ]);
  });

  it('相交但互不包含的两者都保留', () => {
    expect(
      outermostRanges([
        {start: 0, end: 3},
        {start: 2, end: 5},
      ]),
    ).toEqual([
      {start: 0, end: 3},
      {start: 2, end: 5},
    ]);
  });

  it('完全等同的范围只留先出现者（blockquote 与其内 p 同 map）', () => {
    expect(
      outermostRanges([
        {start: 0, end: 1},
        {start: 0, end: 1},
        {start: 4, end: 5},
      ]),
    ).toEqual([
      {start: 0, end: 1},
      {start: 4, end: 5},
    ]);
  });
});

describe('isWholeBlockSelected', () => {
  it('选中文本与块文本一致（空白归一化）判整块', () => {
    expect(isWholeBlockSelected('标题文字', '标题文字')).toBe(true);
    expect(isWholeBlockSelected('  标题\n文字 ', '标题 文字')).toBe(true);
  });

  it('截断选区（块内部分选择）判非整块', () => {
    expect(isWholeBlockSelected('标题', '标题文字')).toBe(false);
    expect(isWholeBlockSelected('标题文字外加', '标题文字')).toBe(false);
  });

  it('空选区判非整块', () => {
    expect(isWholeBlockSelected('', '标题文字')).toBe(false);
    expect(isWholeBlockSelected('   ', '标题文字')).toBe(false);
  });
});

describe('parseMapAttr', () => {
  it('解析合法属性值', () => {
    expect(parseMapAttr('2:7')).toEqual({start: 2, end: 7});
  });

  it('非法格式返回 null', () => {
    expect(parseMapAttr(null)).toBeNull();
    expect(parseMapAttr('')).toBeNull();
    expect(parseMapAttr('abc')).toBeNull();
    expect(parseMapAttr('1:2:3')).toBeNull();
    expect(parseMapAttr('5:3')).toBeNull();
    expect(parseMapAttr('1.5:3')).toBeNull();
  });
});
