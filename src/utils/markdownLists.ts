/**
 * markdown 列表标记改写（修复安卓端列表气泡宽度塌缩）。
 *
 * 背景：react-native-markdown-display 渲染 bullet_list 时，结构是
 * list_item 行 flex 容器 [圆点 | 内容 View flex:1] + 内部 paragraph
 * （width:'100%'、row+flexWrap、行内多 Text 片段）。在气泡宽度由内容
 * 自撑（仅 maxWidth:'100%'）的安卓布局环境下，这条百分比宽 + flex 测量
 * 链会退化：列表文本按极小的可用宽度换行，气泡变成每行几个字的窄竖条；
 * 而普通段落走另一条宽度链，不受影响。
 *
 * 方案：渲染前把「列表标记」改写为普通文本前缀（- → •、1. → 1．），
 * 让列表项按普通段落解析/渲染（已证实宽度正常的路径），视觉保留圆点。
 * 每行改写后追加两个尾随空格（markdown 硬换行），保证行结构在段落内
 * 保持分行显示，而不是被软换行合并成行内空格。
 *
 * 已知取舍：
 * - 列表项换行后贴左边，无悬挂缩进；
 * - 嵌套列表退化为独立圆点行，不保留层级缩进；
 * - 列表项内多段落会并入同一段落（仅以换行区分）。
 * 这些在 agent 输出里极少出现。
 */

/**
 * 将文本中的列表标记行改写为普通段落前缀。
 * - 代码围栏（``` / ~~~）内部不改写；
 * - 支持行首引用前缀（> - x → > • x）；
 * - 有序列表 1. / 1) → 1． / 1），避免改写后仍被识别为列表语法。
 */
export function rewriteListMarkers(text: string): string {
  const lines = text.split('\n');
  let fence: '`' | '~' | null = null; // 当前围栏字符，null 表示不在围栏内

  const out: {line: string; rewritten: boolean}[] = lines.map(line => {
    const open = line.match(/^\s*(`{3,}|~{3,})/);
    if (open) {
      if (fence) {
        // 围栏内：遇到同类型围栏则闭合，否则原样保留
        if (open[1][0] === fence) {
          fence = null;
        }
      } else {
        fence = open[1][0] as '`' | '~';
      }
      return {line, rewritten: false};
    }
    if (fence) {
      return {line, rewritten: false};
    }
    const r = rewriteLine(line);
    return r === null ? {line, rewritten: false} : {line: r, rewritten: true};
  });

  return out
    .map(({line, rewritten}, i) => {
      // 改写行追加行尾双空格（硬换行），末行除外（多余尾随空格无意义）
      return rewritten && i < lines.length - 1 ? `${line}  ` : line;
    })
    .join('\n');
}

/**
 * 改写单行列表标记；返回改写后的行，非列表行返回 null。
 * （不处理围栏，由外层管理。）
 */
function rewriteLine(line: string): string | null {
  // 最多 3 空格缩进 + 引用前缀（> 或 > ）链
  const lead = line.match(/^( {0,3})((?:>\s?)*)/);
  if (!lead) {
    return null;
  }
  const rest = line.slice(lead[0].length);
  if (!rest || /^\s/.test(rest)) {
    return null; // 空行或继续缩进的内容行（非列表标记）
  }
  const bullet = rest.match(/^([-*+])([ \t]|$)/);
  if (bullet) {
    const content = rest.slice(bullet[1].length).replace(/^[ \t]+/, '');
    return `${lead[1]}${lead[2]}• ${content}`;
  }
  const ordered = rest.match(/^(\d{1,9})([.)])([ \t]|$)/);
  if (ordered) {
    const mark = ordered[2] === ')' ? '）' : '．';
    const content = rest.slice(ordered[0].length).replace(/^[ \t]+/, '');
    return `${lead[1]}${lead[2]}${ordered[1]}${mark} ${content}`;
  }
  return null;
}
