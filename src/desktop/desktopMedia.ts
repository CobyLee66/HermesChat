/**
 * desktopMedia — 桌面（Electron）附件来源：主进程对话框选文件 + fs 读字节。
 * 统一输出与手机 picker 兼容的 {uri, name} 形态；图片/文件字节读成 data URL，
 * 上游 media.ts 的 web 分支再做压缩（canvas）。
 */

import {getDesktopBridge} from '../ssh/desktopHermesSsh';
import {alertError} from '../utils/alert';

export interface PickedFile {
  /** data URL（已由主进程读出）或 file:// 路径（原生分支） */
  uri: string;
  name?: string | null;
  mimeType?: string | null;
}

export function hasDesktopMedia(): boolean {
  return getDesktopBridge() != null;
}

/** 图片多选：对话框 → 逐个读成 data URL。取消返回空数组。 */
export async function desktopPickImages(): Promise<PickedFile[]> {
  const bridge = getDesktopBridge();
  if (!bridge) {
    throw new Error('桌面桥不可用');
  }
  const files = await bridge.pickFiles({images: true, multiple: true});
  const out: PickedFile[] = [];
  for (const f of files) {
    try {
      const dataUrl = await bridge.readFileDataUrl(f.path);
      out.push({uri: dataUrl, name: f.name});
    } catch (e) {
      alertError('读取图片失败', e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}

/** 文件单选：对话框 → data URL。取消返回 null。 */
export async function desktopPickFile(): Promise<PickedFile | null> {
  const bridge = getDesktopBridge();
  if (!bridge) {
    throw new Error('桌面桥不可用');
  }
  const [f] = await bridge.pickFiles({images: false, multiple: false});
  if (!f) {
    return null;
  }
  const dataUrl = await bridge.readFileDataUrl(f.path);
  return {uri: dataUrl, name: f.name};
}

/** 拖拽/粘贴进来的文件路径 → data URL（electron File.path 由 preload 解析）。 */
export async function desktopReadFilePath(path: string): Promise<string> {
  const bridge = getDesktopBridge();
  if (!bridge) {
    throw new Error('桌面桥不可用');
  }
  return bridge.readFileDataUrl(path);
}

/** 文本文件选择（SSH 私钥 PEM 等）：对话框 → 读 utf8 内容。取消返回 null。 */
export async function desktopPickTextFile(): Promise<{
  content: string;
  name: string;
} | null> {
  const bridge = getDesktopBridge();
  if (!bridge) {
    throw new Error('桌面桥不可用');
  }
  const [f] = await bridge.pickFiles({images: false, multiple: false});
  if (!f) {
    return null;
  }
  const content = await bridge.readFileText(f.path);
  return {content, name: f.name};
}

/** 系统通知（窗口失焦时回复完成提醒）。 */
export function desktopNotify(title: string, body: string): void {
  const bridge = getDesktopBridge();
  if (!bridge) {
    return;
  }
  bridge.notify({title, body}).catch(() => {
    // 通知失败不影响主流程
  });
}
