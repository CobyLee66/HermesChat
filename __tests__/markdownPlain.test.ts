import {markdownToPlain} from '../src/utils/markdownPlain';

describe('markdownToPlain', () => {
  it('去掉标题/加粗/行内代码语法记号', () => {
    const out = markdownToPlain('# 标题\n\n这是 **加粗** 和 `code` 文本。');
    expect(out).toContain('标题');
    expect(out).toContain('这是 加粗 和 code 文本。');
    expect(out).not.toContain('**');
    expect(out).not.toContain('`');
  });

  it('表格单元格用制表符分隔', () => {
    const out = markdownToPlain(
      '| 城市 | 人口 |\n| --- | --- |\n| 北京 | 2000万 |\n| 上海 | 2500万 |',
    );
    const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
    expect(lines[0]).toBe('城市\t人口');
    expect(lines[1]).toBe('北京\t2000万');
    expect(out).not.toContain('|');
  });

  it('代码块保留原样内容', () => {
    const out = markdownToPlain('```js\nconst a = 1;\n```');
    expect(out).toContain('const a = 1;');
  });
});
