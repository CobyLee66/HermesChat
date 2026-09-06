/**
 * 图片/文件的本地预处理：压缩、base64 读取。
 * 原生依赖（image-resizer / RNFS）集中在这一层，store 与 UI 不直接碰。
 * web/桌面构建走 canvas 分支（输入为 data URL，桌面由主进程读字节）。
 */

import {Platform} from 'react-native';
import ImageResizer from '@bam.tech/react-native-image-resizer';
import RNFS from 'react-native-fs';

export interface PreparedImage {
  /** JPEG 字节流的 base64（image.attach_bytes 的 content_base64） */
  base64: string;
  /** 文件名（统一改成 .jpg —— 内容已是 JPEG，服务端扩展名优先采信文件名） */
  filename: string;
  /** 压缩产物的 file:// URI（本地预览用）；web 分支为 data URL */
  localUri: string;
  width: number;
  height: number;
  /** 压缩后字节数 */
  size: number;
}

/** 文件名换成 .jpg 后缀（内容已被重采样成 JPEG）。 */
function toJpegName(name: string | null | undefined, fallback: string): string {
  const base = (name || fallback || 'image').trim() || 'image';
  return base.replace(/\.[a-z0-9]+$/i, '') + '.jpg';
}

// ─── web/desktop canvas 分支 ─────────────────────────────────────
// 项目 tsconfig 无 DOM lib，全部用结构类型（与 ChatScreen textarea 同款约定）。

interface WebImageEl {
  src: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  naturalWidth: number;
  naturalHeight: number;
}

interface WebCanvas {
  width: number;
  height: number;
  getContext: (kind: '2d') => {
    drawImage: (
      img: WebImageEl,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ) => void;
    fillStyle: string;
    fillRect: (x: number, y: number, w: number, h: number) => void;
  } | null;
  toDataURL: (type: string, quality?: number) => string;
}

function webDoc(): {
  createElement: (tag: 'canvas' | 'img') => WebCanvas & WebImageEl;
} {
  const doc = (globalThis as {document?: unknown}).document;
  if (!doc) {
    throw new Error('web 环境缺少 document');
  }
  return doc as {createElement: (tag: 'canvas' | 'img') => WebCanvas & WebImageEl};
}

function loadImageEl(src: string): Promise<WebImageEl> {
  return new Promise((resolve, reject) => {
    const img = webDoc().createElement('img');
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败（格式不受支持？）'));
    img.src = src;
  });
}

/**
 * canvas 重采样：mode=contain 只缩不放（对齐原生 onlyScaleDown），
 * mode=cover 中心裁正方形（头像）。透明区域垫白底后转 JPEG。
 */
async function webResizeToJpeg(
  src: string,
  maxEdge: number,
  quality: number,
  mode: 'contain' | 'cover',
): Promise<{dataUrl: string; width: number; height: number}> {
  const img = await loadImageEl(src);
  const doc = webDoc();
  const canvas = doc.createElement('canvas');
  let w: number;
  let h: number;
  if (mode === 'cover') {
    w = maxEdge;
    h = maxEdge;
  } else {
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    w = Math.max(1, Math.round(img.naturalWidth * scale));
    h = Math.max(1, Math.round(img.naturalHeight * scale));
  }
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d 上下文不可用');
  }
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  if (mode === 'cover') {
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;
    ctx.drawImage(img, sx, sy, side, side, 0, 0, w, h);
  } else {
    ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, w, h);
  }
  return {dataUrl: canvas.toDataURL('image/jpeg', quality / 100), width: w, height: h};
}

function base64Size(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}

/**
 * 压缩图片并读成 base64：长边缩到 maxEdge 以内（onlyScaleDown），JPEG quality。
 * mode=contain 保持比例，不变形。
 */
export async function prepareImageForUpload(
  uri: string,
  name?: string | null,
  maxEdge = 2048,
  quality = 80,
): Promise<PreparedImage> {
  if (Platform.OS === 'web') {
    const {dataUrl, width, height} = await webResizeToJpeg(
      uri,
      maxEdge,
      quality,
      'contain',
    );
    const marker = 'base64,';
    const base64 = dataUrl.slice(dataUrl.indexOf(marker) + marker.length);
    return {
      base64,
      filename: toJpegName(name, 'image'),
      localUri: dataUrl,
      width,
      height,
      size: base64Size(base64),
    };
  }
  const resized = await ImageResizer.createResizedImage(
    uri,
    maxEdge,
    maxEdge,
    'JPEG',
    quality,
    0,
    undefined,
    false,
    {mode: 'contain', onlyScaleDown: true},
  );
  const base64 = await RNFS.readFile(resized.uri, 'base64');
  return {
    base64,
    filename: toJpegName(name, resized.name),
    localUri: resized.uri,
    width: resized.width,
    height: resized.height,
    size: resized.size,
  };
}

/** 删除沙盒内临时文件（picker 副本/压缩产物），清理失败不影响主流程。 */
export async function deleteTempFile(
  uri: string | null | undefined,
): Promise<void> {
  if (!uri) {
    return;
  }
  if (Platform.OS === 'web') {
    return; // web 分支无临时文件
  }
  try {
    await RNFS.unlink(uri.replace(/^file:\/\//, ''));
  } catch {
    // 已不存在或路径差异：忽略
  }
}

/** 头像预处理：512×512 cover 裁剪成正方形 JPEG q80，输出 data URL（远小于 2MB 上限）。 */
export async function prepareAvatarDataUrl(uri: string): Promise<string> {
  if (Platform.OS === 'web') {
    const {dataUrl} = await webResizeToJpeg(uri, 512, 80, 'cover');
    return dataUrl;
  }
  const resized = await ImageResizer.createResizedImage(
    uri,
    512,
    512,
    'JPEG',
    80,
    0,
    undefined,
    false,
    {mode: 'cover'},
  );
  try {
    const base64 = await RNFS.readFile(resized.uri, 'base64');
    return `data:image/jpeg;base64,${base64}`;
  } finally {
    // 压缩产物只用于读 base64，读完即删，避免缓存目录堆积
    await deleteTempFile(resized.uri);
  }
}

/** 读文件成 data URL（file.attach 的 data_url）。web 分支：桌面选文件时
 *  已由主进程读成 data URL，直接透传。 */
export async function readFileAsDataUrl(
  uri: string,
  mimeType?: string | null,
): Promise<string> {
  if (Platform.OS === 'web') {
    if (uri.startsWith('data:')) {
      return uri;
    }
    throw new Error('web 构建不支持读取本地路径文件');
  }
  const base64 = await RNFS.readFile(uri, 'base64');
  const mime = mimeType || 'application/octet-stream';
  return `data:${mime};base64,${base64}`;
}
