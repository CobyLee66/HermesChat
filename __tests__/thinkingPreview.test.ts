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

  it('换行归一化为空格（防强制换行吃掉行数预算）', () => {
    expect(thinkingTail('第一行\n第二行')).toBe('第一行 第二行');
  });

  describe('宽度感知窗口（maxWidthPx）', () => {
    it('CJK 文本按两行宽度预算截尾', () => {
      // 预算 = 120*2 - 24 = 216px，每字 12px → 恰好 18 字
      const out = thinkingTail('汉'.repeat(100), 120);
      expect(out).toHaveLength(18);
      expect(out.endsWith('汉')).toBe(true);
    });

    it('ASCII 文本同宽度下窗口更长', () => {
      // 预算 = 140*2 - 24 = 256px，每字符 7px → 36 字符
      const out = thinkingTail('a'.repeat(100), 140);
      expect(out).toHaveLength(36);
    });

    it('混排文本窗口跟随最新输出', () => {
      const out = thinkingTail('推'.repeat(50) + 'END', 120);
      expect(out.endsWith('END')).toBe(true);
      // 预算 216px：'END' 21px + 16 个宽字 192px = 213px
      expect(out).toHaveLength(19);
    });

    it('短文本在预算内原样返回', () => {
      expect(thinkingTail('短文本', 500)).toBe('短文本');
    });

    it('宽度为 0/负数时回退固定字符窗口', () => {
      expect(thinkingTail('x'.repeat(300), 0)).toHaveLength(200);
      expect(thinkingTail('x'.repeat(300), -1)).toHaveLength(200);
    });
  });
});
