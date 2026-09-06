/**
 * 头像本地缓存：把 profiles.get_asset 返回的 data URL 转成「确定性 URI」——
 * 原生落盘 file://（Fresco/SDWebImage 按 URI 建内存缓存），web/桌面转 blob:
 * object URL（浏览器按 URL 命中内存缓存）。列表重挂载/切 profile 时按 URI 秒显，
 * 避免 data URI 每次挂载重新解码 + 渐现动画重播导致的肉眼「头像刷新」。
 * 文件/转换操作失败一律返回 null/忽略（调用方回退 data URL，仅 data URL 保留渐现）。
 */

import {Platform} from 'react-native';

import RNFS from 'react-native-fs';

const AVATAR_DIR = `${RNFS.CachesDirectoryPath}/avatars`;

/**
 * web/桌面：profile name → blob: object URL。进程内记忆化保证同一 profile 的
 * URI 稳定（图片内存缓存的命中键）；换图必须先 deleteAvatarFile 再重存
 * （store 的 set/clear/revalidate 流程已是该顺序）。
 */
const webObjectUrls = new Map<string, string>();

/** 浏览器环境依赖（无 DOM lib：结构类型断言，仅 Platform.OS==='web' 分支可达） */
interface WebGlobals {
  atob?: (b64: string) => string;
  Blob?: new (parts: Uint8Array[], opts?: {type: string}) => unknown;
  URL?: {
    createObjectURL?: (obj: unknown) => string;
    revokeObjectURL?: (url: string) => void;
  };
}

function webGlobals(): WebGlobals {
  // RN 自带的全局 Blob 类型与浏览器实际签名有出入，经 unknown 收敛为所需最小面
  return globalThis as unknown as WebGlobals;
}

/** data URL → Blob → blob: URL；同 profile 已有则直接复用，失败返回 null */
function saveAvatarObjectUrl(
  name: string,
  parsed: {mime: string; base64: string},
): string | null {
  const cached = webObjectUrls.get(name);
  if (cached) {
    return cached;
  }
  try {
    const {atob, Blob: BlobCtor, URL: urlApi} = webGlobals();
    if (!atob || !BlobCtor || !urlApi?.createObjectURL) {
      return null;
    }
    const bin = atob(parsed.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    const url = urlApi.createObjectURL(new BlobCtor([bytes], {type: parsed.mime}));
    webObjectUrls.set(name, url);
    return url;
  } catch {
    return null;
  }
}

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

/**
 * data URL 转确定性 URI：原生落盘返回 file://，web/桌面返回 blob: object URL，
 * 失败返回 null
 */
export async function saveAvatarFile(
  name: string,
  dataUrl: string,
): Promise<string | null> {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    return null;
  }
  if (Platform.OS === 'web') {
    return saveAvatarObjectUrl(name, parsed);
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
  if (Platform.OS === 'web') {
    // 浏览器无持久存储：object URL 不跨冷启动，冷启动首拉必走 RPC（渐现属真实加载）
    return null;
  }
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

/** 删除该 profile 的本地头像缓存（web 撤销 object URL；原生三个扩展名都试），失败忽略 */
export async function deleteAvatarFile(name: string): Promise<void> {
  if (Platform.OS === 'web') {
    const url = webObjectUrls.get(name);
    if (url !== undefined) {
      webObjectUrls.delete(name);
      try {
        webGlobals().URL?.revokeObjectURL?.(url);
      } catch {
        // revoke 失败不影响失效语义（调用方不再复用旧 URL）
      }
    }
    return;
  }
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
