import {parseMessageText} from '../src/rpc/references';

const DATA_URL = `data:image/jpeg;base64,${'A'.repeat(80)}`;

describe('parseMessageText @image: 指令', () => {
  it('裸路径指令行：提取 path，文本剥离', () => {
    const r = parseMessageText(
      '看看这张图\n@image:/home/u/.hermes/images/upload_20260902_1.png',
    );
    expect(r.text).toBe('看看这张图');
    expect(r.images).toEqual([
      {path: '/home/u/.hermes/images/upload_20260902_1.png'},
    ]);
    expect(r.files).toEqual([]);
  });

  it('引用值带引号（路径含空格）：去引号保留空格', () => {
    const r = parseMessageText('@image:`/tmp/my pics/a b.jpg`');
    expect(r.text).toBe('');
    expect(r.images).toEqual([{path: '/tmp/my pics/a b.jpg'}]);
  });

  it('双引号包裹同样识别', () => {
    const r = parseMessageText('@image:"/tmp/xx y.png"');
    expect(r.images).toEqual([{path: '/tmp/xx y.png'}]);
  });

  it('http(s) URL 的 @image: 提取为 uri 而非 path', () => {
    const r = parseMessageText('@image:https://example.com/x.png');
    expect(r.images).toEqual([{uri: 'https://example.com/x.png'}]);
  });

  it('纯指令消息：文本为空但保留 images', () => {
    const r = parseMessageText(
      '@image:/a/1.png\n@image:/a/2.png',
    );
    expect(r.text).toBe('');
    expect(r.images).toHaveLength(2);
  });

  it('caption 在前、指令尾随（服务端持久化形态）', () => {
    const r = parseMessageText('这是什么\n@image:/a/1.png\n@image:/a/2.png');
    expect(r.text).toBe('这是什么');
    expect(r.images.map(i => i.path)).toEqual(['/a/1.png', '/a/2.png']);
  });
});

describe('parseMessageText @file: 指令', () => {
  it('提取文件引用并生成显示名', () => {
    const r = parseMessageText('帮我看 @file:attachments/2026/报表.pdf');
    expect(r.files).toEqual([
      {ref: 'attachments/2026/报表.pdf', name: '报表.pdf'},
    ]);
    expect(r.text).not.toContain('@file:');
  });

  it('带引号的文件引用', () => {
    const r = parseMessageText("@file:'my docs/note.txt'");
    expect(r.files).toEqual([{ref: 'my docs/note.txt', name: 'note.txt'}]);
  });

  it('其他 @kind（url/folder/…）保留在文本里不动', () => {
    const text = '打开 @url:https://example.com 这个链接';
    const r = parseMessageText(text);
    expect(r.text).toBe(text);
    expect(r.images).toEqual([]);
    expect(r.files).toEqual([]);
  });
});

describe('parseMessageText 内嵌 data:image URL', () => {
  it('独立行 data URL 提取为 uri 图片', () => {
    const r = parseMessageText(`生成好了\n${DATA_URL}`);
    expect(r.text).toBe('生成好了');
    expect(r.images).toEqual([{uri: DATA_URL}]);
  });

  it('payload 太短（<64）不当图片，原样保留', () => {
    const text = 'data:image/png;base64,AAAA';
    const r = parseMessageText(text);
    expect(r.images).toEqual([]);
    expect(r.text).toBe(text);
  });

  it('同一消息里 data URL 与 @image: 混合', () => {
    const r = parseMessageText(`图\n${DATA_URL}\n@image:/x/y.png`);
    expect(r.images).toEqual([{uri: DATA_URL}, {path: '/x/y.png'}]);
    expect(r.text).toBe('图');
  });
});

describe('parseMessageText 无引用', () => {
  it('普通文本只 trim，不改动内容', () => {
    expect(parseMessageText('  你好世界  ').text).toBe('你好世界');
    expect(parseMessageText('').text).toBe('');
  });
});
