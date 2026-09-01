/**
 * 消息文本里的引用指令与内嵌图片解析。
 *
 * 移植自 hermes desktop（只读参考，保持行为一致）：
 * - `apps/desktop/src/components/assistant-ui/reference-kinds.ts` 的
 *   REFERENCE_PATTERN（`@kind:value`，value 可用反引号/单双引号包裹）；
 * - `apps/desktop/src/lib/embedded-images.ts` 的 extractEmbeddedImages
 *   （`data:image/…;base64,…` 扫描，payload 至少 64 字符）。
 *
 * 服务端把持久化的图片消息写成 `@image:<path>` 指令行
 * （tui_gateway/server.py `_build_persist_message_with_image_refs`），
 * 原生视觉 turn 的 image_url content part 经 `_coerce_message_text` 拍平时
 * 把 url（多为 data: URI）以独立行追加进 text。两者都在这里还原成 ImageRef。
 */

import type {FileRef, ImageRef} from './types';

/** 与 desktop REFERENCE_PATTERN 同形：`(?!…)` 不需要，\S+ 兜底。 */
const REFERENCE_RE =
  /@(file|folder|url|image|tool|line|terminal|session):(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)/g;

const DATA_IMAGE_PREFIX = 'data:image/';
const BASE64_MARKER = ';base64,';
/** 与 desktop 一致：payload 短于 64 字符不当成图片（避免误吞普通文本）。 */
const MIN_EMBEDDED_IMAGE_BASE64_LENGTH = 64;

export interface ParsedMessageText {
  /** 剥离指令与内嵌图片后的纯文本（已 trim、折叠空行） */
  text: string;
  images: ImageRef[];
  files: FileRef[];
}

function isImageMimeChar(ch: string): boolean {
  return /[\w.+-]/.test(ch);
}

function isBase64Char(ch: string): boolean {
  return /[A-Za-z0-9+/=]/.test(ch);
}

/** 从 start 处尝试读一个 data:image URL；失败返回 null。 */
function readDataImageUrl(
  text: string,
  start: number,
): {end: number; url: string} | null {
  if (!text.startsWith(DATA_IMAGE_PREFIX, start)) {
    return null;
  }
  let cursor = start + DATA_IMAGE_PREFIX.length;
  while (cursor < text.length && isImageMimeChar(text[cursor])) {
    cursor += 1;
  }
  if (
    cursor === start + DATA_IMAGE_PREFIX.length ||
    !text.startsWith(BASE64_MARKER, cursor)
  ) {
    return null;
  }
  cursor += BASE64_MARKER.length;
  const base64Start = cursor;
  while (cursor < text.length && isBase64Char(text[cursor])) {
    cursor += 1;
  }
  if (cursor - base64Start < MIN_EMBEDDED_IMAGE_BASE64_LENGTH) {
    return null;
  }
  return {end: cursor, url: text.slice(start, cursor)};
}

/** 提取内嵌 data:image URL（image_url content part 拍平产物），返回清洗后文本。 */
function extractEmbeddedImages(text: string): {text: string; urls: string[]} {
  if (!text.includes(DATA_IMAGE_PREFIX)) {
    return {text, urls: []};
  }
  const urls: string[] = [];
  const pieces: string[] = [];
  let appendCursor = 0;
  let searchCursor = 0;
  while (searchCursor < text.length) {
    const dataStart = text.indexOf(DATA_IMAGE_PREFIX, searchCursor);
    if (dataStart === -1) {
      break;
    }
    const found = readDataImageUrl(text, dataStart);
    if (!found) {
      searchCursor = dataStart + DATA_IMAGE_PREFIX.length;
      continue;
    }
    pieces.push(text.slice(appendCursor, dataStart));
    urls.push(found.url);
    appendCursor = found.end;
    searchCursor = found.end;
  }
  if (urls.length === 0) {
    return {text, urls: []};
  }
  pieces.push(text.slice(appendCursor));
  return {text: pieces.join(''), urls};
}

/** 去掉引用值的包裹引号（反引号/单引号/双引号）。 */
function unwrapRefValue(raw: string): string {
  if (raw.length < 2) {
    return raw;
  }
  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === '`' || first === '"' || first === "'") && last === first) {
    return raw.slice(1, -1);
  }
  return raw;
}

/** 文件卡片显示名：取路径末段。 */
function fileDisplayName(ref: string): string {
  const trimmed = ref.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function normalizeCleanedText(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 解析一条消息文本：提取 @image:/@file: 指令与内嵌 data:image URL。
 * 其余 @kind（folder/url/tool/line/terminal/session）保留在文本里原样显示。
 */
export function parseMessageText(raw: string): ParsedMessageText {
  if (!raw) {
    return {text: '', images: [], files: []};
  }

  // 1) 内嵌 data:image URL（先于指令：@image:data:… 的畸形组合让指令先吃掉也无妨，
  //    但正常产物是独立行，先提 URL 更稳）
  const embedded = extractEmbeddedImages(raw);
  let text = embedded.text;
  const images: ImageRef[] = embedded.urls.map(uri => ({uri}));
  const files: FileRef[] = [];

  // 2) @image:/@file: 指令（引用值可能带引号）
  const matches: {start: number; end: number; kind: string; value: string}[] = [];
  const re = new RegExp(REFERENCE_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const kind = m[1];
    if (kind !== 'image' && kind !== 'file') {
      continue;
    }
    matches.push({start: m.index, end: m.index + m[0].length, kind, value: m[2]});
  }
  if (matches.length > 0) {
    const pieces: string[] = [];
    let cursor = 0;
    for (const match of matches) {
      pieces.push(text.slice(cursor, match.start));
      const value = unwrapRefValue(match.value);
      if (match.kind === 'image') {
        if (/^https?:\/\//i.test(value)) {
          images.push({uri: value});
        } else {
          images.push({path: value});
        }
      } else {
        files.push({ref: value, name: fileDisplayName(value)});
      }
      cursor = match.end;
    }
    pieces.push(text.slice(cursor));
    text = pieces.join('');
  }

  return {text: normalizeCleanedText(text), images, files};
}
