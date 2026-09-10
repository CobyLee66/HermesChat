import {thinkingHead, thinkingTail} from '../src/utils/thinkingPreview';

describe('thinkingHead（结束后开头一行预览）', () => {
  it('空文本返回空串', () => {
    expect(thinkingHead('')).toBe('');
    expect(thinkingHead('   \n  ')).toBe('');
  });

  it('多行文本取首行', () => {
    expect(thinkingHead('第一行思考\n第二行思考\n第三行')).toBe('第一行思考');
  });

  it('首行超长截断加省略号', () => {
    const long = 'a'.repeat(200);
    const out = thinkingHead(long);
    expect(out.length).toBe(121);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('a')).toBe(true);
  });

  it('首行不超长时原样返回', () => {
    expect(thinkingHead('简短思考')).toBe('简短思考');
  });
});

describe('thinkingTail（流式中尾部实时窗口）', () => {
  it('空文本返回空串', () => {
    expect(thinkingTail('')).toBe('');
  });

  it('不足窗口长度时原样返回', () => {
    expect(thinkingTail('最新的思考')).toBe('最新的思考');
  });

  it('超过窗口长度时取尾部', () => {
    const text = 'x'.repeat(50) + '尾' + 'y'.repeat(199);
    expect(thinkingTail(text)).toBe(text.slice(-200));
    expect(thinkingTail(text).endsWith('y')).toBe(true);
    expect(thinkingTail(text)).toHaveLength(200);
  });

  it('长文本流式增长时窗口跟随最新输出', () => {
    const base = 'a'.repeat(300);
    const grown = base + '新输出';
    expect(thinkingTail(grown).endsWith('新输出')).toBe(true);
  });
});
