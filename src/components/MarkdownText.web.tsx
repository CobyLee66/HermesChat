import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import MarkdownIt from 'markdown-it';

import {Colors} from './theme';
import {useT} from '../i18n';
import {
  injectSrcMapRule,
  parseMapAttr,
  sliceSourceLines,
  unionLineRange,
  type LineRange,
} from '../utils/mdSourceMap';

/**
 * MarkdownText 的 web 实现（vite 链路：浏览器调试 + Electron 桌面共用）。
 * react-native-markdown-display 主入口是未编译 JSX，rolldown/vite 无法解析，
 * 故 web 端走 markdown-it → HTML；表格包一层 overflow-x:auto 容器可横向滚动。
 * markdown-it 默认 html:false（原文 HTML 转义），并拦截 javascript: 链接。
 *
 * 桌面端文本复制策略（与手机端长按弹层不同）：
 * ① 拖选气泡内文本后 Cmd/Ctrl+C，剪贴板得到所选范围的 Markdown 源码——
 *    块级 token 注入 data-md-map 源行号，copy 事件拦截后按选区覆盖的块
 *    切出源码（块级粒度，不会复制出半截表格/列表；跨消息选择不干预，
 *    浏览器默认复制渲染后文本）；
 * ② 气泡右键菜单：整条复制 Markdown 源码 / 复制渲染后纯文本。
 */

const md = new MarkdownIt({linkify: true, breaks: false});
injectSrcMapRule(md);

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

let stylesInjected = false;

/**
 * hm-md 样式只在首个气泡挂载时注入一次。此前每气泡渲染一份 <style>，长会话
 * 首次滚动批量挂载历史消息时重复插入样式表，每次都触发全文档样式重算，
 * 是首滚掉帧的一大来源。
 */
function ensureMarkdownStyles() {
  if (stylesInjected) {
    return;
  }
  const doc = (globalThis as {
    document?: {
      createElement?: (tag: string) => {textContent?: string};
      head?: {appendChild?: (el: unknown) => void};
    };
  }).document;
  if (!doc?.createElement || !doc.head?.appendChild) {
    return;
  }
  const style = doc.createElement('style');
  style.textContent = CSS;
  doc.head.appendChild(style);
  stylesInjected = true;
}

ensureMarkdownStyles();

/** md.render 结果缓存（FIFO 有界）：长会话滚动时 cell 频繁卸载重挂载，
 * 命中缓存可跳过重复解析渲染。流式期间同一条消息的中间文本也会进缓存
 * （命中不了，只为限流内存），FIFO 逐渐淘汰。 */
const renderCache = new Map<string, string>();
const RENDER_CACHE_MAX = 300;

function cachedRender(text: string): string {
  const hit = renderCache.get(text);
  if (hit !== undefined) {
    return hit;
  }
  const html = md.render(text);
  renderCache.set(text, html);
  if (renderCache.size > RENDER_CACHE_MAX) {
    const oldest = renderCache.keys().next().value;
    if (oldest !== undefined) {
      renderCache.delete(oldest);
    }
  }
  return html;
}

/* ---------- DOM 最小能力面（无 DOM lib：结构类型断言） ---------- */

/** 挂载 copy 拦截与 contextmenu 的宿主节点（web 下即 hm-md 容器 div）。 */
interface MdHostNode {
  addEventListener?: (type: string, listener: (e: unknown) => void) => void;
  removeEventListener?: (type: string, listener: (e: unknown) => void) => void;
  contains?: (node: unknown) => boolean;
  querySelectorAll?: (
    sel: string,
  ) => {forEach: (cb: (el: {dataset?: {mdMap?: string}}) => void) => void};
  innerText?: string;
}

interface CopyEventLike {
  target?: unknown;
  clipboardData?: {setData?: (type: string, value: string) => void} | null;
  preventDefault?: () => void;
}

interface RangeLike {
  intersectsNode?: (node: unknown) => boolean;
  startContainer?: unknown;
  endContainer?: unknown;
}

interface SelectionLike {
  isCollapsed?: boolean;
  rangeCount?: number;
  getRangeAt?: (index: number) => RangeLike;
}

interface ContextMenuEventLike {
  clientX?: number;
  clientY?: number;
  preventDefault?: () => void;
}

/* ---------- copy 拦截（模块级单例 + 容器注册表） ----------
 * copy 事件派发到 document.activeElement（通常 body），不会冒泡经过气泡
 * 容器——必须在 document 上挂单例监听，各气泡内容组件注册自身。 */

interface Registered {
  node: MdHostNode;
  getText: () => string;
}

const registry = new Set<Registered>();
let interceptorInstalled = false;

function isEditableTarget(target: unknown): boolean {
  const t = target as {tagName?: string; isContentEditable?: boolean} | null;
  if (!t) {
    return false;
  }
  const tag = String(t.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable === true;
}

function handleDocumentCopy(raw: unknown) {
  const e = raw as CopyEventLike;
  // 输入框等可编辑元素里的复制不干预
  if (isEditableTarget(e.target)) {
    return;
  }
  const sel = (globalThis as {
    getSelection?: () => SelectionLike | null;
  }).getSelection?.();
  if (!sel || sel.isCollapsed !== false || !sel.rangeCount) {
    return;
  }
  const range = sel.getRangeAt?.(0);
  if (!range) {
    return;
  }
  // 只处理起止都落在同一气泡内容里的选择；跨消息/伸出气泡交给浏览器默认
  let host: Registered | undefined;
  for (const item of registry) {
    if (
      item.node.contains?.(range.startContainer) &&
      item.node.contains?.(range.endContainer)
    ) {
      host = item;
      break;
    }
  }
  if (!host) {
    return;
  }
  // 选区覆盖的带行号块取行范围并集，切出源码替换剪贴板
  const ranges: LineRange[] = [];
  host.node.querySelectorAll?.('[data-md-map]')?.forEach(el => {
    if (range.intersectsNode?.(el) !== true) {
      return;
    }
    const r = parseMapAttr(el.dataset?.mdMap ?? null);
    if (r) {
      ranges.push(r);
    }
  });
  const merged = unionLineRange(ranges);
  if (!merged) {
    return;
  }
  const src = sliceSourceLines(host.getText(), merged.start, merged.end);
  if (!src) {
    return;
  }
  e.clipboardData?.setData?.('text/plain', src);
  e.preventDefault?.();
}

function ensureCopyInterceptor() {
  if (interceptorInstalled) {
    return;
  }
  const doc = (globalThis as {
    document?: {addEventListener?: (t: string, l: (e: unknown) => void) => void};
  }).document;
  if (!doc?.addEventListener) {
    return;
  }
  doc.addEventListener('copy', handleDocumentCopy);
  interceptorInstalled = true;
}

/** 浏览器剪贴板写入（RNW 无 Clipboard 模块；SessionColumn 同款写法）。 */
function writeClipboard(value: string) {
  const clipboard = (globalThis as {
    navigator?: {clipboard?: {writeText?: (t: string) => Promise<void>}};
  }).navigator?.clipboard;
  clipboard?.writeText?.(value)?.catch(() => {});
}

/* ---------- 组件 ---------- */

/** 右键菜单卡估算尺寸（定位 clamp 防溢出窗口用） */
const MENU_WIDTH = 190;
const MENU_HEIGHT = 96;

interface Props {
  text: string;
}

export function MarkdownText({text}: Props) {
  const t = useT();
  const html = useMemo(() => cachedRender(text), [text]);
  const hostRef = useRef<MdHostNode | null>(null);
  // 流式更新时注册表里的 getText 走 ref 取最新源文本
  const textRef = useRef(text);
  const [menuPos, setMenuPos] = useState<{x: number; y: number} | null>(null);
  const {width: winW, height: winH} = useWindowDimensions();

  useEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    const node = hostRef.current;
    // 原生端无 addEventListener 能力，effect 内自然跳过（先例：SessionListPanel）
    if (!node?.addEventListener) {
      return undefined;
    }
    const entry = {node, getText: () => textRef.current};
    registry.add(entry);
    ensureCopyInterceptor();
    // React 的 onContextMenu 合成事件在本项目 web 环境实测不派发，挂原生监听
    const onContextMenu = (raw: unknown) => {
      const e = raw as ContextMenuEventLike;
      e.preventDefault?.();
      setMenuPos({x: e.clientX ?? 0, y: e.clientY ?? 0});
    };
    node.addEventListener('contextmenu', onContextMenu);
    return () => {
      registry.delete(entry);
      node.removeEventListener?.('contextmenu', onContextMenu);
    };
  }, []);

  const closeMenu = () => setMenuPos(null);

  const onCopyMarkdown = () => {
    writeClipboard(textRef.current);
    closeMenu();
  };

  const onCopyPlain = () => {
    writeClipboard(hostRef.current?.innerText ?? '');
    closeMenu();
  };

  // 菜单贴光标弹出；靠右/靠下时向内收避免溢出窗口
  const menuLeft = menuPos ? Math.min(menuPos.x, winW - MENU_WIDTH - 8) : 0;
  const menuTop = menuPos ? Math.min(menuPos.y, winH - MENU_HEIGHT - 8) : 0;

  return (
    <>
      <div
        className="hm-md"
        ref={node => {
          hostRef.current = node as unknown as MdHostNode | null;
        }}
        dangerouslySetInnerHTML={{__html: html}}
      />
      {/* 气泡右键菜单（web/桌面；backdrop 点击或 Esc 关闭） */}
      {menuPos !== null ? (
        <Modal visible transparent animationType="fade" onRequestClose={closeMenu}>
          <TouchableOpacity
            style={styles.menuBackdrop}
            activeOpacity={1}
            onPress={closeMenu}>
            <View style={[styles.menuCard, {left: menuLeft, top: menuTop}]}>
              <TouchableOpacity style={styles.menuItem} onPress={onCopyMarkdown}>
                <Text style={styles.menuText}>{t('md.copyMarkdown')}</Text>
              </TouchableOpacity>
              <View style={styles.menuSep} />
              <TouchableOpacity style={styles.menuItem} onPress={onCopyPlain}>
                <Text style={styles.menuText}>{t('md.copyPlain')}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Modal>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.15)',
  },
  menuCard: {
    position: 'absolute',
    backgroundColor: Colors.card,
    borderRadius: 12,
    width: MENU_WIDTH,
    paddingVertical: 4,
    overflow: 'hidden',
    // 阴影让菜单与背景分层（web/原生通吃写法）
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: {width: 0, height: 4},
    elevation: 8,
  },
  menuItem: {paddingVertical: 11, paddingHorizontal: 16},
  menuText: {fontSize: 14, color: Colors.text},
  menuSep: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.border,
    marginVertical: 4,
  },
});
