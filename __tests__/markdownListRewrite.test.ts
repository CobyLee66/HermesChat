/**
 * markdown 列表标记改写测试：见 src/utils/markdownLists.ts 头部注释
 * （安卓端列表气泡宽度塌缩的修复）。
 * 断言改写后文本经 markdown-it 解析不再产生列表 token（列表按普通段落渲染）。
 */

import MarkdownIt from 'markdown-it';

import {rewriteListMarkers} from '../src/utils/markdownLists';

const md = new MarkdownIt();

/** 解析并返回 token 类型列表 */
function tokenTypes(text: string): string[] {
  return md.parse(text, {}).map(t => t.type);
}

describe('rewriteListMarkers 无序列表', () => {
  it('把 - 开头的行改写成 • 开头的普通文本（改写行带硬换行尾随空格）', () => {
    const out = rewriteListMarkers('- 苹果\n- 香蕉');
    expect(out).toBe('• 苹果  \n• 香蕉');
  });

  it('支持 * / + 标记与行内代码/加粗', () => {
    const out = rewriteListMarkers('* a `code`\n+ b **加粗**');
    expect(out).toBe('• a `code`  \n• b **加粗**');
  });

  it('改写后 markdown 不再解析出列表 token', () => {
    const src = '📋 备份报告\n- 提交状态：成功（新增 `e42d22e`）\n- 推送状态：成功';
    const out = rewriteListMarkers(src);
    const types = tokenTypes(out);
    expect(types).not.toContain('bullet_list_open');
    expect(types).not.toContain('ordered_list_open');
    expect(types).not.toContain('list_item_open');
    expect(types).toContain('paragraph_open');
  });

  it('真实消息（22821 备份报告）改写后不再有列表 token', () => {
    const src =
      '📋 备份报告\n- 提交状态：成功（.hermes 仓库新提交 `e42d22e`「OpenClaw智能备份 - 2026-09-04 07:01:31」，共 331 个文件变更，+24094/-1658；AI-Docs 仓库无变更）\n- 推送状态：成功（已通过 SSH 推送到 GitHub）\n- 备注：本次提交包含跨 profile 技能目录重构（github→software-development 迁移、blocked-page-recovery 移入 web）、新增 pdf 处理脚本、会话仓库诊断文档等。备份执行正常，无异常。';
    const out = rewriteListMarkers(src);
    expect(out.startsWith('📋 备份报告\n• 提交状态：成功')).toBe(true);
    expect(out).toContain('`e42d22e`');
    expect(out).toContain('• 推送状态：成功');
    expect(out).toContain('• 备注：本次提交');
    const types = tokenTypes(out);
    expect(types).not.toContain('bullet_list_open');
    expect(types).not.toContain('ordered_list_open');
    expect(types).not.toContain('list_item_open');
    expect(types).toContain('paragraph_open');
  });
});

describe('rewriteListMarkers 有序列表与边界', () => {
  it('1. 改写为 1．，避免仍被解析为列表', () => {
    const out = rewriteListMarkers('1. 第一\n10) 第十');
    expect(out).toBe('1． 第一  \n10） 第十');
    const types = tokenTypes(out);
    expect(types).not.toContain('ordered_list_open');
    expect(types).not.toContain('list_item_open');
  });

  it('代码围栏内部不改写', () => {
    const src = '说明：\n```\n- 不要改我\n```\n- 外面改我';
    const out = rewriteListMarkers(src);
    expect(out).toBe('说明：\n```\n- 不要改我\n```\n• 外面改我');
  });

  it('引用内的列表改写后仍在引用内', () => {
    const out = rewriteListMarkers('> - 引用项');
    expect(out).toBe('> • 引用项');
  });

  it('4 空格缩进（代码块行）与原样行不改写', () => {
    const src = '普通段落\n    - 这是缩进代码行\n*斜体开头且后无空白*';
    expect(rewriteListMarkers(src)).toBe(src);
  });

  it('非标记符号不误伤：加粗/斜体与行内减号', () => {
    const src = '**加粗**与*斜体*，还有 a-b 减号和 3.14 小数';
    expect(rewriteListMarkers(src)).toBe(src);
  });
});
