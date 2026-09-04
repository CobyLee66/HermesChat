/**
 * 工具变更 diff 的清洗与解析（对齐 hermes 桌面端 diff-lines.ts 的口径）。
 *
 * 服务端两个来源：
 * - tool.complete 的 inline_diff：display.py 渲染产物，内嵌 ANSI 色码、
 *   首行 `┊ review diff`、`a/x → b/x` 箭头行，按 6 文件/80 行截断；
 * - patch 工具 result JSON 的 diff 字段：原始 unified diff（无 ANSI）。
 */

/** 单行 diff 的展示分类。 */
export type DiffLineKind = 'add' | 'remove' | 'context' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  /** 已去掉 +/-/空格 gutter 的内容（meta 行保留原样） */
  text: string;
}

export interface DiffStats {
  added: number;
  removed: number;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, '');
}

/** 清洗 inline_diff：去 ANSI、去 `┊ review diff` 头行、去首尾空白。 */
export function cleanInlineDiff(value: string): string {
  if (!value) {
    return '';
  }
  return stripAnsi(value)
    .replace(/^\s*┊\s*review diff\s*\n/i, '')
    .trim();
}

/** 从工具 result（对象或 JSON 字符串）里取原始 unified diff（patch 工具）。 */
export function diffFromResult(result: unknown): string {
  if (!result) {
    return '';
  }
  const record =
    typeof result === 'string'
      ? safeParseJson(result)
      : (result as Record<string, unknown>);
  if (!record || typeof record !== 'object') {
    return '';
  }
  const diff = record.diff;
  return typeof diff === 'string' && diff.trim() ? diff : '';
}

function safeParseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function diffKind(line: string): DiffLineKind {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return 'add';
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return 'remove';
  }
  return 'context';
}

/** 统一 diff 的文件头前缀（git 风格 + hermes 箭头行），渲染时归为 meta。 */
const DIFF_HEADER_PREFIXES = [
  'diff --git',
  'index ',
  '--- ',
  '+++ ',
  'similarity ',
  'rename ',
  'new file',
  'deleted file',
];

function isArrowHeaderLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.includes('→') && /^\S.*→\s*\S+$/.test(trimmed) && !/^[+\-@]/.test(trimmed)
  );
}

/**
 * unified diff → 渲染行列表。文件头/@@/省略行归 meta（弱化显示），
 * +/-/context 行去掉行首 gutter 字符、按 kind 着色；无法按 hunk 解析时
 * 整体按行分类兜底。
 */
export function parseDiffLines(diff: string): DiffLine[] {
  const cleaned = cleanInlineDiff(diff);
  if (!cleaned) {
    return [];
  }
  const rawLines = cleaned.split('\n');
  const out: DiffLine[] = [];
  let sawHunk = false;
  for (const line of rawLines) {
    if (line.startsWith('@@')) {
      sawHunk = true;
      out.push({kind: 'meta', text: line});
      continue;
    }
    if (
      !sawHunk &&
      (line.trim() === '' ||
        isArrowHeaderLine(line) ||
        DIFF_HEADER_PREFIXES.some(p => line.startsWith(p)))
    ) {
      if (line.trim() !== '') {
        out.push({kind: 'meta', text: line.trim()});
      }
      continue;
    }
    const kind = diffKind(line);
    out.push({
      kind,
      // context 行以空格开头（gutter）；add/remove 以 +/- 开头
      text: kind === 'context' && !line.startsWith(' ') ? line : line.slice(1),
    });
  }
  return out;
}

/** 统计 +/- 行数（忽略 +++/--- 文件头）。 */
export function countDiffStats(diff: string): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of cleanInlineDiff(diff).split('\n')) {
    const kind = diffKind(line);
    if (kind === 'add') {
      added += 1;
    } else if (kind === 'remove') {
      removed += 1;
    }
  }
  return {added, removed};
}

/** 从 args 里取文件路径（write_file/patch 等文件编辑工具的展示名）。 */
export function fileEditPath(
  args: Record<string, unknown> | undefined,
): string {
  if (!args) {
    return '';
  }
  for (const key of ['path', 'file', 'filepath']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) {
      return v;
    }
  }
  return '';
}
