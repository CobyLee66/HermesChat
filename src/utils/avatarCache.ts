/**
 * 头像本地落盘缓存：把 profiles.get_asset 返回的 data URL 写成沙盒缓存文件，
 * Image 改喂 file:// URI —— 原生管线（Fresco/SDWebImage）按 URI 建内存缓存，
 * 列表重挂载时直接命中位图，避免 data URI 每次挂载重新 base64 解码导致的闪烁。
 * 文件操作失败一律返回 null/忽略（调用方回退 data URL，web 端 RNFS stub 全 reject 走回退）。
 */

import RNFS from 'react-native-fs';

const AVATAR_DIR = `${RNFS.CachesDirectoryPath}/avatars`;

/** mime → 扩展名（只可能是上传时的 JPEG/PNG/WebP） */
function extOf(mime: string | undefined): string {
  if (mime === 'image/png') {
    return 'png';
  }
  if (mime === 'image/webp') {
    return 'webp';
  }
  return 'jpg';
}

/**
 * 文件名 = 简单多项式哈希 + name 前缀：profile name 可能含路径非法字符，
 * 统一收敛为安全文件名；带上可读前缀也进一步降低哈希碰撞显示错头像的风险。
 */
function avatarPath(name: string, ext: string): string {
  let hash = 7;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) % 0x7fffffff;
  }
  const prefix = encodeURIComponent(name).slice(0, 40) || 'profile';
  return `${AVATAR_DIR}/${prefix}-${hash.toString(16)}.${ext}`;
}

/** 解析 data:<mime>;base64,<b64>，非 base64 data URL 返回 null */
function parseDataUrl(dataUrl: string): {mime: string; base64: string} | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) {
    return null;
  }
  return {mime: match[1], base64: match[2]};
}

/** data URL 落盘，成功返回 file:// URI，失败返回 null */
export async function saveAvatarFile(
  name: string,
  dataUrl: string,
): Promise<string | null> {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    return null;
  }
  const path = avatarPath(name, extOf(parsed.mime));
  try {
    await RNFS.mkdir(AVATAR_DIR);
    await RNFS.writeFile(path, parsed.base64, 'base64');
    return `file://${path}`;
  } catch {
    return null;
  }
}

/** 本地缓存信息：file:// URI + 文件字节数（供 store 与远端 asset.size 对比判新旧） */
export interface CachedAvatarInfo {
  uri: string;
  size: number;
}

/** 本地已有缓存文件则返回其信息，否则 null（扩展名未知，三个都试） */
export async function cachedAvatarInfo(
  name: string,
): Promise<CachedAvatarInfo | null> {
  for (const ext of ['jpg', 'png', 'webp']) {
    const path = avatarPath(name, ext);
    try {
      if (!(await RNFS.exists(path))) {
        continue;
      }
      const stat = await RNFS.stat(path);
      return {uri: `file://${path}`, size: Number(stat.size)};
    } catch {
      // 单个扩展名探测失败：继续试下一个
    }
  }
  return null;
}

/** 删除该 profile 的本地头像缓存（扩展名未知，三个都试），失败忽略 */
export async function deleteAvatarFile(name: string): Promise<void> {
  for (const ext of ['jpg', 'png', 'webp']) {
    try {
      const path = avatarPath(name, ext);
      if (await RNFS.exists(path)) {
        await RNFS.unlink(path);
      }
    } catch {
      // 已不存在或删除失败：忽略
    }
  }
}
