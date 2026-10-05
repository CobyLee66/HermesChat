/**
 * CJK 语境下 `*` 强调标记的渲染前修复（加粗/斜体被标点贴边失效）。
 *
 * 背景：markdown-it 严格实现 CommonMark 的 flanking 规则——
 * - 开符（左 flank）：后不能跟空白；后跟标点时，前面必须是空白或标点；
 * - 闭符（右 flank）：前不能是空白；前是标点时，后面必须是空白或标点。
 * CJK 正文里汉字是「字母」而非标点，于是 `是**"重点"**。`（开符前汉字、
 * 后引号）与 `**"重点"**弄`（闭符前引号、后汉字）都不满足规则，`**`
 * 原样落出。真实消息示例（已脱敏）：「汉字是**"是否值得坚持"**。」整句加粗丢失。
 *
 * 方案：渲染前在失配侧插入零宽空格 U+200B（既非标点也非空白，恰好把
 * flanking 判定「解锁」）：
 * - 开符修复：`X**P`（X=非空非标点，P=标点）→ `X**\u200BP`；
 * - 闭符修复：`P**X`（P=标点，X=非空非标点）→ `P\u200B**X`。
 * 零宽空格不可见，不改变排版观感；复制入口（web 复制源码/原生长按弹层）
 * 拿的都是原始文本，不会把 ZWSP 带出去。
 *
 * 边界：
 * - 围栏代码块（``` / ~~~）与行内代码 span（同长反引号配对）内部不动；
 * - 反斜杠转义的 \* 不是定界符，跳过；
 * - 只插到「本来会失败」的那一侧，已合法的 `**正常**加粗` 原样不动。
 */

const ZWSP = '​';

/** CommonMark 标点 = Unicode P + S 类别（与 markdown-it isPunctChar 一致） */
const PUNCT = /[\p{P}\p{S}]/u;
const WS = /\s/u;

function isPunct(ch: string | undefined): boolean {
  return ch !== undefined && PUNCT.test(ch);
}

/** 行首/行尾等「无字符」位置按 CommonMark 视为空白 */
function isWs(ch: string | undefined): boolean {
  return ch === undefined || WS.test(ch);
}

/** 找同长反引号闭符；找不到返回 -1（该开符按字面量处理） */
function findClosingTicks(line: string, from: number, len: number): number {
  let i = from;
  for (;;) {
    const idx = line.indexOf('`', i);
    if (idx === -1) {
      return -1;
    }
    let j = idx;
    while (j < line.length && line[j] === '`') {
      j++;
    }
    if (j - idx === len) {
      return idx;
    }
    i = j;
  }
}

/** 修复单行（不含围栏处理，由外层管理） */
function fixLine(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '`') {
      // 行内代码 span：同长反引号配对，配对成功则整段原样跳过
      let j = i;
      while (j < line.length && line[j] === '`') {
        j++;
      }
      const close = findClosingTicks(line, j, j - i);
      if (close === -1) {
        out += line.slice(i, j);
        i = j;
        continue;
      }
      out += line.slice(i, close + (j - i));
      i = close + (j - i);
      continue;
    }
    if (ch === '*') {
      let j = i;
      while (j < line.length && line[j] === '*') {
        j++;
      }
      const prev = i > 0 ? line[i - 1] : undefined;
      const next = j < line.length ? line[j] : undefined;
      if (prev === '\\') {
        // 转义星号不是定界符
        out += line.slice(i, j);
        i = j;
        continue;
      }
      // 闭符修复：前是标点、后是非空非标点 → 前插 ZWSP
      if (isPunct(prev) && next !== undefined && !isWs(next) && !isPunct(next)) {
        out += ZWSP;
      }
      out += line.slice(i, j);
      // 开符修复：前是非空非标点、后是标点 → 后插 ZWSP
      if (prev !== undefined && !isWs(prev) && !isPunct(prev) && isPunct(next)) {
        out += ZWSP;
      }
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * 修复文本中因 CJK flanking 规则失效的 * 强调标记。
 * 无失配标记时原样返回（不分配新字符串之外的副作用）。
 */
export function fixCjkEmphasis(text: string): string {
  const lines = text.split('\n');
  let fence: '`' | '~' | null = null; // 当前围栏字符，null 表示不在围栏内

  return lines
    .map(line => {
      const open = line.match(/^\s*(`{3,}|~{3,})/);
      if (open) {
        if (fence) {
          if (open[1][0] === fence) {
            fence = null;
          }
        } else {
          fence = open[1][0] as '`' | '~';
        }
        return line;
      }
      if (fence) {
        return line;
      }
      return fixLine(line);
    })
    .join('\n');
}
