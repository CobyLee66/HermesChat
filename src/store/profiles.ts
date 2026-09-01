/**
 * profile 列表 store：profiles.list + profiles.get_asset（头像，失败用昵称首字符色块兜底）。
 */

import {create} from 'zustand';

import {getRpc} from '../rpc/runtime';
import type {ProfileAsset, ProfileInfo} from '../rpc/types';

interface ProfilesStore {
  list: ProfileInfo[];
  /** name → data URL */
  avatars: Record<string, string>;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
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
}));
