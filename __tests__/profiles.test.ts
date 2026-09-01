/**
 * profiles store 编辑 action 测试：mock rpc，断言调用参数形状与刷新/缓存失效行为。
 * 不打真实服务（profiles.configure / set_asset 都是写操作）。
 */

import {useProfilesStore} from '../src/store/profiles';
import type {ProfileInfo} from '../src/rpc/types';

const mockCall = jest.fn<Promise<unknown>, [string, unknown?]>();

jest.mock('../src/rpc/runtime', () => ({
  getRpc: () => ({call: mockCall}),
  setRpc: jest.fn(),
  hasRpc: () => true,
}));

function makeProfile(name: string, extra?: Partial<ProfileInfo>): ProfileInfo {
  return {
    name,
    path: `/profiles/${name}`,
    is_default: false,
    model: 'deepseek-chat',
    provider: 'custom:DeepSeek',
    description: `${name} 助手`,
    skill_count: 0,
    last_session: null,
    ...extra,
  };
}

function resetStore() {
  useProfilesStore.setState({list: [], avatars: {}, loading: false, error: null});
  mockCall.mockReset();
}

describe('profiles store 编辑', () => {
  beforeEach(resetStore);

  it('updateNickname：profiles.configure 传 ui_meta 键级合并，随后刷新 list', async () => {
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'profiles.configure') {
        return {ok: true, applied: {ui_meta: true}};
      }
      if (method === 'profiles.list') {
        return {profiles: [makeProfile('main', {ui_meta: {nickname: '示例 agent'}})]};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });

    await useProfilesStore.getState().updateNickname('main', '示例 agent');

    expect(mockCall).toHaveBeenCalledWith('profiles.configure', {
      name: 'main',
      ui_meta: {nickname: '示例 agent'},
    });
    expect(mockCall).toHaveBeenCalledWith('profiles.list');
    const meta = useProfilesStore.getState().list[0].ui_meta as {
      nickname?: string;
    };
    expect(meta.nickname).toBe('示例 agent');
  });

  it('updateNickname 空串 → 传 null 删除键', async () => {
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'profiles.configure') {
        return {ok: true, applied: {ui_meta: true}};
      }
      if (method === 'profiles.list') {
        return {profiles: [makeProfile('main')]};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });

    await useProfilesStore.getState().updateNickname('main', '   ');

    expect(mockCall).toHaveBeenCalledWith('profiles.configure', {
      name: 'main',
      ui_meta: {nickname: null},
    });
  });

  it('updateNickname 服务端 applied.ui_meta=false 时抛错', async () => {
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'profiles.configure') {
        return {ok: false, applied: {ui_meta: false}};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });

    await expect(
      useProfilesStore.getState().updateNickname('main', 'x'),
    ).rejects.toThrow('昵称写入失败');
  });

  it('setAvatar：set_asset 传 data，头像缓存失效后重新拉取', async () => {
    useProfilesStore.setState({
      avatars: {main: 'data:image/png;base64,OLD'},
    });
    const calls: string[] = [];
    mockCall.mockImplementation(async (method: string) => {
      calls.push(method);
      if (method === 'profiles.set_asset') {
        return {ok: true, asset: 'avatar', size: 1234};
      }
      if (method === 'profiles.list') {
        return {profiles: [makeProfile('main', {has_avatar: true})]};
      }
      if (method === 'profiles.get_asset') {
        return {found: true, data: 'data:image/jpeg;base64,FRESH'};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });

    await useProfilesStore
      .getState()
      .setAvatar('main', 'data:image/jpeg;base64,NEW');

    expect(mockCall).toHaveBeenCalledWith('profiles.set_asset', {
      name: 'main',
      asset: 'avatar',
      data: 'data:image/jpeg;base64,NEW',
    });
    // set_asset → list → get_asset 顺序；旧缓存被新 data URL 替换
    expect(calls).toEqual([
      'profiles.set_asset',
      'profiles.list',
      'profiles.get_asset',
    ]);
    expect(useProfilesStore.getState().avatars.main).toBe(
      'data:image/jpeg;base64,FRESH',
    );
  });

  it('clearAvatar：set_asset clear:true，缓存删除且不再拉取', async () => {
    useProfilesStore.setState({
      avatars: {main: 'data:image/png;base64,OLD'},
    });
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'profiles.set_asset') {
        return {ok: true, asset: 'avatar', size: 0, removed: 1};
      }
      if (method === 'profiles.list') {
        return {profiles: [makeProfile('main', {has_avatar: false})]};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });

    await useProfilesStore.getState().clearAvatar('main');

    expect(mockCall).toHaveBeenCalledWith('profiles.set_asset', {
      name: 'main',
      asset: 'avatar',
      clear: true,
    });
    expect(useProfilesStore.getState().avatars.main).toBeUndefined();
    expect(
      mockCall.mock.calls.some(c => c[0] === 'profiles.get_asset'),
    ).toBe(false);
  });
});
