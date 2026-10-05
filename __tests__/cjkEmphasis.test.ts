/**
 * CJK 强调标记修复测试：见 src/utils/cjkEmphasis.ts 头部注释
 *（`是**"重点"**。` 这类「汉字+引号」贴边在 CommonMark flanking 规则下
 * 加粗失效，修复 = 失配侧插零宽空格）。
 * 断言修复后文本经 markdown-it 解析产生 strong/em token，且不改变
 * 代码块/行内代码/已合法标记的内容。
 *
 * 注意：renderInline 会把直引号转义为 &quot;，且修复插入的 ZWSP 会留在
 * strong/em 内部——断言一律剥掉 ZWSP 后再比对，或对 &quot; 形态断言。
 */

import MarkdownIt from 'markdown-it';

import {fixCjkEmphasis} from '../src/utils/cjkEmphasis';

const md = new MarkdownIt();
const ZWSP = '​';

/** 行内解析为 HTML，便于断言 strong/em */
function inline(text: string): string {
  return md.renderInline(fixCjkEmphasis(text));
}

/** 剥掉 ZWSP（修复手段本身，不属于内容断言） */
function stripZwsp(html: string): string {
  return html.split(ZWSP).join('');
}

describe('fixCjkEmphasis 开符修复（汉字 + 开符 + 标点）', () => {
  it('是**"是否值得坚持"**。 → 加粗生效', () => {
    const html = inline('这件事的关键是**"是否值得坚持"**。');
    expect(stripZwsp(html)).toContain('<strong>&quot;是否值得坚持&quot;</strong>');
    expect(html).not.toContain('**');
  });

  it('全角括号贴边：是**（x）**。 → 加粗生效', () => {
    expect(stripZwsp(inline('是**（x）**。'))).toContain('<strong>（x）</strong>');
  });

  it('单星号斜体同类问题：是*"斜"*。 → 斜体生效', () => {
    const html = inline('是*"斜"*。');
    expect(stripZwsp(html)).toContain('<em>&quot;斜&quot;</em>');
    expect(html).not.toContain('*');
  });
});

describe('fixCjkEmphasis 闭符修复（标点 + 闭符 + 汉字）', () => {
  it('。**"x"**字 → 加粗生效', () => {
    expect(stripZwsp(inline('。**"x"**字'))).toContain('<strong>&quot;x&quot;</strong>');
  });

  it('双侧都坏：把**"这块"**弄好 → 加粗生效', () => {
    expect(stripZwsp(inline('把**"这块"**弄好'))).toContain(
      '<strong>&quot;这块&quot;</strong>',
    );
  });
});

describe('fixCjkEmphasis 不误伤', () => {
  it('已合法加粗原样不动', () => {
    const src = '**正常**加粗 与 字**正常**';
    expect(fixCjkEmphasis(src)).toBe(src);
  });

  it('裸露星号（两侧空白）原样不动', () => {
    const src = 'a ** b ** c';
    expect(fixCjkEmphasis(src)).toBe(src);
  });

  it('转义星号 \\* 不动', () => {
    const src = '转义 \\**"x"**。';
    expect(fixCjkEmphasis(src)).toBe(src);
  });

  it('行内代码 span 内部不动', () => {
    const src = '看 `是**"x"**。` 这段代码';
    expect(fixCjkEmphasis(src)).toBe(src);
  });

  it('围栏代码块内部不动', () => {
    const src = '说明：\n```\n是**"x"**。 代码里别动\n```\n是**"y"**。 外面要修';
    const out = fixCjkEmphasis(src);
    expect(out).toContain('\n是**"x"**。 代码里别动\n');
    expect(inline('是**"y"**。 外面要修')).toContain('<strong>');
    expect(out).not.toBe(src);
  });

  it('未闭合的行内代码开符按字面量处理（后续星号仍修复）', () => {
    const out = fixCjkEmphasis('半个 `code 是**"x"**。');
    expect(md.renderInline(out)).toContain('<strong>');
  });
});

describe('fixCjkEmphasis 真实消息回归', () => {
  it('真实场景等价句：加粗生效、无 ** 残留', () => {
    // 逐字来自 state.db 消息 id=22906
    const src =
      '但我想加一句：这件事的关键是**"是否值得坚持"**。';
    const html = inline(src);
    expect(stripZwsp(html)).toContain('<strong>&quot;是否值得坚持&quot;</strong>');
    expect(html).not.toContain('**');
  });
});
