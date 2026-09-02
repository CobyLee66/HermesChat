import React, {useMemo} from 'react';
import MarkdownIt from 'markdown-it';

/**
 * MarkdownText 的 web 实现（vite 调试链路）。
 * react-native-markdown-display 主入口是未编译 JSX，rolldown/vite 无法解析，
 * 故 web 端走 markdown-it → HTML；表格包一层 overflow-x:auto 容器可横向滚动。
 * markdown-it 默认 html:false（原文 HTML 转义），并拦截 javascript: 链接。
 */

const md = new MarkdownIt({linkify: true, breaks: false});

// 表格外层包 .hm-md-table-wrap，超出宽度横向滚动
const defaultTableOpen =
  md.renderer.rules.table_open?.bind(md.renderer) ??
  ((tokens, i, opts, _env, self) => self.renderToken(tokens, i, opts));
md.renderer.rules.table_open = (tokens, i, opts, env, self) =>
  `<div class="hm-md-table-wrap">${defaultTableOpen(tokens, i, opts, env, self)}`;
const defaultTableClose =
  md.renderer.rules.table_close?.bind(md.renderer) ??
  ((tokens, i, opts, _env, self) => self.renderToken(tokens, i, opts));
md.renderer.rules.table_close = (tokens, i, opts, env, self) =>
  `${defaultTableClose(tokens, i, opts, env, self)}</div>`;

const CSS = `
.hm-md { font-size: 16px; line-height: 23px; color: #1A1A1A; word-break: break-word; }
.hm-md p { margin: 4px 0; }
.hm-md h1 { font-size: 24px; margin: 6px 0; } .hm-md h2 { font-size: 20px; margin: 5px 0; }
.hm-md h3 { font-size: 17px; margin: 4px 0; } .hm-md h4, .hm-md h5, .hm-md h6 { font-size: 15px; margin: 3px 0; }
.hm-md a { color: #0E9BD8; }
.hm-md hr { border: none; border-top: 1px solid #E5E6EB; }
.hm-md blockquote { margin: 4px 0; padding: 2px 8px; background: #F7F8FA; border-left: 3px solid #E5E6EB; }
.hm-md ul, .hm-md ol { margin: 2px 0; padding-left: 22px; }
.hm-md code { background: #F7F8FA; border: 1px solid #E5E6EB; border-radius: 4px; padding: 0 4px; font-family: monospace; font-size: 14px; }
.hm-md pre { background: #F7F8FA; border: 1px solid #E5E6EB; border-radius: 8px; padding: 10px; overflow-x: auto; }
.hm-md pre code { background: none; border: none; padding: 0; font-size: 13px; line-height: 19px; }
.hm-md-table-wrap { overflow-x: auto; margin: 6px 0; }
.hm-md table { border-collapse: collapse; border: 1px solid #E5E6EB; border-radius: 6px; }
.hm-md th, .hm-md td { border: 1px solid #E5E6EB; padding: 5px 8px; min-width: 72px; white-space: nowrap; }
.hm-md thead tr { background: #F7F8FA; }
.hm-md img { max-width: 100%; }
`;

interface Props {
  text: string;
}

export function MarkdownText({text}: Props) {
  const html = useMemo(() => md.render(text), [text]);
  return (
    <>
      <style>{CSS}</style>
      <div className="hm-md" dangerouslySetInnerHTML={{__html: html}} />
    </>
  );
}
