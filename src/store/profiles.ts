/**
 * profile 列表 store：profiles.list + profiles.get_asset（头像，失败用昵称首字符色块兜底）。
 * 头像缓存：拉到的 data URL 落盘为 file://（utils/avatarCache），map 存 file URI ——
 * 原生图片管线按 URI 建内存缓存，列表重挂载时免解码秒显；落盘失败回退存 data URL。
 * 会话首轮 refresh 对已有缓存后台 revalidate 一次（对比 asset.size，防其他端改动后陈旧）。
 * 编辑：updateNickname（profiles.configure ui_meta 键级合并）/ setAvatar / clearAvatar
 * （profiles.set_asset），成功后删本地缓存文件并刷新重拉。
 */

import {create} from 'zustand';

import {getRpc} from '../rpc/runtime';
import type {
  ProfileAsset,
  ProfileInfo,
  ProfilesConfigureResult,
  ProfilesSetAssetResult,
} from '../rpc/types';
import {
  cachedAvatarInfo,
  deleteAvatarFile,
  saveAvatarFile,
} from '../utils/avatarCache';

interface ProfilesStore {
  list: ProfileInfo[];
  /** name → 可直接喂 Image 的 URI（file:// 缓存优先，落盘失败为 data URL） */
  avatars: Record<string, string>;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  /** 昵称（ui_meta.nickname）；传空串/null 删除该键（回退 description/name） */
  updateNickname(name: string, nickname: string | null): Promise<void>;
  /** 上传头像（data URL 或 base64；PNG/JPEG/WebP，≤2MB） */
  setAvatar(name: string, data: string): Promise<void>;
  /** 删除头像，恢复昵称首字符色块 */
  clearAvatar(name: string): Promise<void>;
}

// 本次 App 会话是否已对头像做过一轮 revalidate（模块级，进程内最多一轮）
let avatarRevalidated = false;

export const useProfilesStore = create<ProfilesStore>((set, get) => {
  /** get_asset → 落盘 → 更新 map（落盘失败回退 data URL）；失败静默（色块兜底） */
  async function fetchAvatar(name: string): Promise<void> {
    try {
      const asset = await getRpc().call<ProfileAsset>(
        'profiles.get_asset',
        {name, asset: 'avatar'},
      );
      if (asset && asset.found && asset.data) {
        const data = asset.data;
        const uri = await saveAvatarFile(name, data);
        set(s => ({avatars: {...s.avatars, [name]: uri ?? data}}));
      }
    } catch {
      // 无头像/拉取失败：色块兜底
    }
  }

  /**
   * 会话首轮新鲜度检查：远端 size 为解码后字节数（服务端 len(blob)），
   * 与本地落盘文件一致即跳过；不一致或远端已清除才动本地。
   */
  async function revalidateAvatar(name: string): Promise<void> {
    try {
      const info = await cachedAvatarInfo(name);
      if (!info) {
        return;
      }
      const asset = await getRpc().call<ProfileAsset>(
        'profiles.get_asset',
        {name, asset: 'avatar'},
      );
      if (asset && asset.found && asset.data) {
        const data = asset.data;
        if (asset.size === undefined || asset.size !== info.size) {
          await deleteAvatarFile(name);
          const uri = await saveAvatarFile(name, data);
          set(s => ({avatars: {...s.avatars, [name]: uri ?? data}}));
        }
      } else if (asset && !asset.found) {
        // 远端已清头像（其他端操作）：清本地缓存与 map
        await deleteAvatarFile(name);
        set(s => {
          const avatars = {...s.avatars};
          delete avatars[name];
          return {avatars};
        });
      }
    } catch {
      // 校验失败：保用现值
    }
  }

  return {
    list: [],
    avatars: {},
    loading: false,
    error: null,

    async refresh() {
      set({loading: true, error: null});
      try {
        const rpc = getRpc();
        const raw = await rpc.call<{profiles?: ProfileInfo[]} | ProfileInfo[]>(
          'profiles.list',
        );
        // 实测返回 {profiles: [...]}；保留数组兼容
        const list = Array.isArray(raw)
          ? raw
          : ((raw as {profiles?: ProfileInfo[]}).profiles ?? []);
        set({list, loading: false});

        const withAvatar = list.filter(p => p.has_avatar);

        // 1. 本地缓存文件先立即上屏（冷启动秒显，不等 RPC）
        const missingLocal = withAvatar.filter(p => !get().avatars[p.name]);
        const infos = await Promise.all(
          missingLocal.map(
            async p => [p.name, await cachedAvatarInfo(p.name)] as const,
          ),
        );
        set(s => {
          const avatars = {...s.avatars};
          for (const [name, info] of infos) {
            if (info && !avatars[name]) {
              avatars[name] = info.uri;
            }
          }
          return {avatars};
        });

        // 2. 后台补拉无缓存的；会话首轮对已有缓存的 revalidate（进程内最多一轮）
        const missing = withAvatar.filter(p => !get().avatars[p.name]);
        const stale = avatarRevalidated
          ? []
          : withAvatar.filter(p => get().avatars[p.name]);
        avatarRevalidated = true;
        await Promise.all([
          ...missing.map(p => fetchAvatar(p.name)),
          ...stale.map(p => revalidateAvatar(p.name)),
        ]);

        // 3. 远端已无头像的：清 map 与本地文件
        const cleared = list.filter(p => !p.has_avatar && get().avatars[p.name]);
        if (cleared.length > 0) {
          set(s => {
            const avatars = {...s.avatars};
            for (const p of cleared) {
              delete avatars[p.name];
            }
            return {avatars};
          });
          await Promise.all(cleared.map(p => deleteAvatarFile(p.name)));
        }
      } catch (e) {
        set({loading: false, error: e instanceof Error ? e.message : String(e)});
      }
    },

    async updateNickname(name, nickname) {
      // ui_meta 键级合并：值为 null 删除该键（源码 methods_profiles.py）
      const value = nickname && nickname.trim() ? nickname.trim() : null;
      const result = await getRpc().call<ProfilesConfigureResult>(
        'profiles.configure',
        {name, ui_meta: {nickname: value}},
      );
      if (result && result.applied && result.applied.ui_meta === false) {
        throw new Error('昵称写入失败（服务端 ui_meta 未应用）');
      }
      await get().refresh();
    },

    async setAvatar(name, data) {
      await getRpc().call<ProfilesSetAssetResult>('profiles.set_asset', {
        name,
        asset: 'avatar',
        data,
      });
      // 缓存失效：删本地文件与 map 项，refresh 重拉新图并重新落盘
      await deleteAvatarFile(name);
      set(s => {
        const avatars = {...s.avatars};
        delete avatars[name];
        return {avatars};
      });
      await get().refresh();
    },

    async clearAvatar(name) {
      await getRpc().call<ProfilesSetAssetResult>('profiles.set_asset', {
        name,
        asset: 'avatar',
        clear: true,
      });
      await deleteAvatarFile(name);
      set(s => {
        const avatars = {...s.avatars};
        delete avatars[name];
        return {avatars};
      });
      await get().refresh();
    },
  };
});
