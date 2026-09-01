/**
 * 图片/文件的本地预处理：压缩、base64 读取。
 * 原生依赖（image-resizer / RNFS）集中在这一层，store 与 UI 不直接碰。
 */

import ImageResizer from '@bam.tech/react-native-image-resizer';
import RNFS from 'react-native-fs';

export interface PreparedImage {
  /** JPEG 字节流的 base64（image.attach_bytes 的 content_base64） */
  base64: string;
  /** 文件名（统一改成 .jpg —— 内容已是 JPEG，服务端扩展名优先采信文件名） */
  filename: string;
  /** 压缩产物的 file:// URI（本地预览用） */
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

/** 头像预处理：512×512 cover 裁剪成正方形 JPEG q80，输出 data URL（远小于 2MB 上限）。 */
export async function prepareAvatarDataUrl(uri: string): Promise<string> {
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
  const base64 = await RNFS.readFile(resized.uri, 'base64');
  return `data:image/jpeg;base64,${base64}`;
}

/** 读文件成 data URL（file.attach 的 data_url）。 */
export async function readFileAsDataUrl(
  uri: string,
  mimeType?: string | null,
): Promise<string> {
  const base64 = await RNFS.readFile(uri, 'base64');
  const mime = mimeType || 'application/octet-stream';
  return `data:${mime};base64,${base64}`;
}
