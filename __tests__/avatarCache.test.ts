/**
 * avatarCache 单测：data URL 解析落盘（mime→扩展名）、file:// URI 返回、
 * 失败回退 null、删除后不再命中。RNFS 走 __mocks__ 有状态 mock。
 */

import RNFS from 'react-native-fs';

import {
  cachedAvatarInfo,
  deleteAvatarFile,
  saveAvatarFile,
} from '../src/utils/avatarCache';

const writeFile = RNFS.writeFile as jest.Mock;
const unlink = RNFS.unlink as jest.Mock;
const resetFiles = (RNFS as unknown as {__resetFiles: () => void})
  .__resetFiles;

beforeEach(() => {
  resetFiles();
});

describe('avatarCache', () => {
  it('saveAvatarFile：解析 data URL 落盘，返回 file:// URI（jpg）', async () => {
    const uri = await saveAvatarFile('main', 'data:image/jpeg;base64,QUJD');
    expect(uri).toMatch(/^file:\/\/\/tmp\/caches\/avatars\//);
    expect(uri).toMatch(/\.jpg$/);
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.jpg$/),
      'QUJD',
      'base64',
    );
  });

  it('saveAvatarFile：扩展名跟随 mime（png/webp）', async () => {
    const png = await saveAvatarFile('a', 'data:image/png;base64,QUJD');
    expect(png).toMatch(/\.png$/);
    const webp = await saveAvatarFile('b', 'data:image/webp;base64,QUJD');
    expect(webp).toMatch(/\.webp$/);
  });

  it('saveAvatarFile：非法 data URL 返回 null', async () => {
    expect(await saveAvatarFile('main', 'not-a-data-url')).toBeNull();
    expect(await saveAvatarFile('main', 'data:image/jpeg,QUJD')).toBeNull();
  });

  it('saveAvatarFile：写盘失败返回 null', async () => {
    writeFile.mockRejectedValueOnce(new Error('disk full'));
    expect(await saveAvatarFile('main', 'data:image/jpeg;base64,QUJD')).toBeNull();
  });

  it('cachedAvatarInfo：命中时返回 file URI 与文件大小', async () => {
    const uri = await saveAvatarFile('main', 'data:image/jpeg;base64,QUJD');
    const info = await cachedAvatarInfo('main');
    expect(info).not.toBeNull();
    expect(info?.uri).toBe(uri);
    expect(info?.size).toBe(42);
  });

  it('cachedAvatarInfo：无缓存返回 null', async () => {
    expect(await cachedAvatarInfo('ghost')).toBeNull();
  });

  it('deleteAvatarFile：删除后不再命中', async () => {
    await saveAvatarFile('main', 'data:image/jpeg;base64,QUJD');
    await deleteAvatarFile('main');
    expect(await cachedAvatarInfo('main')).toBeNull();
    expect(unlink).toHaveBeenCalled();
  });
});
