import {
  cleanInlineDiff,
  countDiffStats,
  diffFromResult,
  fileEditPath,
  parseDiffLines,
  stripAnsi,
} from '../src/rpc/diffText';

const ANSI = '\x1b[38;2;255;255;255;48;2;20;90;20m';

describe('diffText 工具变更 diff 解析', () => {
  it('stripAnsi 去掉 SGR 色码', () => {
    expect(stripAnsi(`${ANSI}+new\x1b[0m`)).toBe('+new');
  });

  it('cleanInlineDiff 去 ANSI + ┊ review diff 头 + 首尾空白', () => {
    const raw = `  ${ANSI}┊ review diff\x1b[0m\n${ANSI}a/x.ts → b/x.ts\x1b[0m\n@@ -1 +1 @@\n`;
    expect(cleanInlineDiff(raw)).toBe('a/x.ts → b/x.ts\n@@ -1 +1 @@');
  });

  it('parseDiffLines：文件头/箭头/@@ 归 meta，+/-/context 去 gutter', () => {
    const lines = parseDiffLines(
      [
        'a/src/app.ts → b/src/app.ts',
        '@@ -10,7 +10,8 @@',
        ' context line',
        '-removed line',
        '+added line',
        '… omitted 12 diff line(s) across 2 additional file(s)/section(s)',
      ].join('\n'),
    );
    expect(lines).toEqual([
      {kind: 'meta', text: 'a/src/app.ts → b/src/app.ts'},
      {kind: 'meta', text: '@@ -10,7 +10,8 @@'},
      {kind: 'context', text: 'context line'},
      {kind: 'remove', text: 'removed line'},
      {kind: 'add', text: 'added line'},
      {kind: 'context', text: '… omitted 12 diff line(s) across 2 additional file(s)/section(s)'},
    ]);
  });

  it('parseDiffLines：无 hunk 头的原始行按前缀分类兜底', () => {
    expect(parseDiffLines('+a\n-b\nc')).toEqual([
      {kind: 'add', text: 'a'},
      {kind: 'remove', text: 'b'},
      {kind: 'context', text: 'c'},
    ]);
  });

  it('parseDiffLines：git 文件头（---/+++/diff --git）归 meta', () => {
    const lines = parseDiffLines(
      'diff --git a/x b/x\nindex 123..456\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n+新',
    );
    expect(lines.map(l => l.kind)).toEqual([
      'meta',
      'meta',
      'meta',
      'meta',
      'meta',
      'add',
    ]);
    expect(lines[5].text).toBe('新');
  });

  it('countDiffStats 统计 +/-（忽略 +++/--- 头）', () => {
    const diff = '--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n-旧1\n-旧2\n 共同\n+新1';
    expect(countDiffStats(diff)).toEqual({added: 1, removed: 2});
  });

  it('countDiffStats 兼容带 ANSI 的 inline_diff', () => {
    expect(countDiffStats(`${ANSI}+a\x1b[0m\n${ANSI}-b\x1b[0m`)).toEqual({
      added: 1,
      removed: 1,
    });
  });

  it('diffFromResult：result 对象 / JSON 字符串的 diff 字段', () => {
    expect(diffFromResult({ok: true, diff: '+x'})).toBe('+x');
    expect(diffFromResult('{"ok":true,"diff":"+y"}')).toBe('+y');
    expect(diffFromResult('not json')).toBe('');
    expect(diffFromResult({ok: true})).toBe('');
    expect(diffFromResult(undefined)).toBe('');
  });

  it('fileEditPath 从 args 取路径', () => {
    expect(fileEditPath({path: 'src/a.ts'})).toBe('src/a.ts');
    expect(fileEditPath({file: 'b.py'})).toBe('b.py');
    expect(fileEditPath({})).toBe('');
    expect(fileEditPath(undefined)).toBe('');
  });
});
