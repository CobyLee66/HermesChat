import {Platform} from 'react-native';

import {prepareOriginalImageForUpload} from '../src/utils/media';

const realOS = Platform.OS;

afterEach(() => {
  (Platform as unknown as {OS: string}).OS = realOS;
});

describe('prepareOriginalImageForUpload（web data URL）', () => {
  it('直接透传 base64，不经 canvas，并按 MIME 补原格式后缀', async () => {
    (Platform as unknown as {OS: string}).OS = 'web';
    const uri = 'data:image/png;base64,aGVsbG8=';

    const prepared = await prepareOriginalImageForUpload(uri);

    expect(prepared).toEqual({
      base64: 'aGVsbG8=',
      filename: 'image.png',
      localUri: uri,
      size: 5,
    });
  });

  it('显式文件名优先，原始 data URL 保持不变', async () => {
    (Platform as unknown as {OS: string}).OS = 'web';
    const uri = 'data:image/jpeg;base64,aGVsbG8=';

    const prepared = await prepareOriginalImageForUpload(uri, 'photo.jpg');

    expect(prepared.filename).toBe('photo.jpg');
    expect(prepared.localUri).toBe(uri);
    expect(prepared.base64).toBe('aGVsbG8=');
  });
});
