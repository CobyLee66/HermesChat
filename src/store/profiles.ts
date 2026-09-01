/**
 * profile 列表 store：profiles.list + profiles.get_asset（头像，失败用昵称首字符色块兜底）。
 * 编辑：updateNickname（profiles.configure ui_meta 键级合并）/ setAvatar / clearAvatar
 * （profiles.set_asset），成功后刷新 list 并让头像缓存失效重拉。
 */

import {create} from 'zustand';

import {getRpc} from '../rpc/runtime';
import type {
  ProfileAsset,
  ProfileInfo,
  ProfilesConfigureResult,
  ProfilesSetAssetResult,
} from '../rpc/types';

interface ProfilesStore {
  list: ProfileInfo[];
  /** name → data URL */
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

export const useProfilesStore = create<ProfilesStore>((set, get) => ({
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
      // 头像并发拉取，失败忽略（UI 用昵称首字符色块）
      await Promise.all(
        list
          .filter(p => p.has_avatar && !get().avatars[p.name])
          .map(async p => {
            try {
              const asset = await rpc.call<ProfileAsset>('profiles.get_asset', {
                name: p.name,
                asset: 'avatar',
              });
              if (asset && asset.found && asset.data) {
                set(s => ({avatars: {...s.avatars, [p.name]: asset.data!}}));
              }
            } catch {
              // 无头像/拉取失败：色块兜底
            }
          }),
      );
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
    // 缓存失效：删掉旧 data URL，refresh 会按 has_avatar 重拉新图
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
    set(s => {
      const avatars = {...s.avatars};
      delete avatars[name];
      return {avatars};
    });
    await get().refresh();
  },
}));
