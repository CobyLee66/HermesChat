/**
 * avatarCache web/桌面分支单测：data URL → blob: object URL 的确定性缓存。
 * mock Platform.OS='web' 与 URL.createObjectURL/revokeObjectURL，断言：
 * 同 profile 的 object URL 稳定（图片内存缓存命中键）、删除后重建新 URL、
 * 非法 data URL 回退 null、cachedAvatarInfo 恒 null（web 无持久缓存）。
 */

jest.mock('react-native', () => ({
  Platform: {
    OS: 'web',
    select: (o: {web?: unknown; default?: unknown}) => o.web ?? o.default,
  },
}));

import {
  cachedAvatarInfo,
  deleteAvatarFile,
  saveAvatarFile,
} from '../src/utils/avatarCache';

interface MockBlob {
  size: number;
  type: string;
}

let urlSeq = 0;
const revoked: string[] = [];
const blobs: MockBlob[] = [];

class FakeBlob {
  size: number;
  type: string;
  constructor(parts: Uint8Array[], opts?: {type?: string}) {
    this.size = parts.reduce((n, p) => n + p.length, 0);
    this.type = opts?.type ?? '';
    blobs.push(this);
  }
}

beforeAll(() => {
  const g = globalThis as unknown as {
    atob?: (b64: string) => string;
    Blob?: unknown;
    URL: {
      createObjectURL?: (obj: unknown) => string;
      revokeObjectURL?: (url: string) => void;
    };
  };
  if (!g.atob) {
    throw new Error('测试环境缺少 atob（Node ≥16 应自带）');
  }
  g.Blob = FakeBlob;
  g.URL.createObjectURL = (_obj: unknown) => `blob:mock-${++urlSeq}`;
  g.URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
});

describe('avatarCache web 分支（blob: object URL）', () => {
  it('saveAvatarFile：返回 blob: URL，Blob 带原始 mime 与解码后字节数', async () => {
    const url = await saveAvatarFile('main', 'data:image/jpeg;base64,QUJD');
    expect(url).toMatch(/^blob:mock-\d+$/);
    expect(blobs[blobs.length - 1]).toMatchObject({size: 3, type: 'image/jpeg'});
  });

  it('saveAvatarFile：同 profile 重复保存返回同一 URI（进程内稳定缓存键）', async () => {
    const first = await saveAvatarFile('stable', 'data:image/png;base64,QUJD');
    const second = await saveAvatarFile(
      'stable',
      'data:image/png;base64,QUJD',
    );
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it('saveAvatarFile：不同 profile 各自独立 URI', async () => {
    const a = await saveAvatarFile('a', 'data:image/png;base64,QUJD');
    const b = await saveAvatarFile('b', 'data:image/png;base64,QUJD');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it('deleteAvatarFile：撤销 URL 并清缓存，重新保存得到新 URI', async () => {
    const first = await saveAvatarFile('changer', 'data:image/jpeg;base64,QUJD');
    await deleteAvatarFile('changer');
    expect(revoked).toContain(first);
    const second = await saveAvatarFile(
      'changer',
      'data:image/jpeg;base64,REY=',
    );
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('saveAvatarFile：非法 data URL 返回 null', async () => {
    expect(await saveAvatarFile('bad', 'not-a-data-url')).toBeNull();
    expect(await saveAvatarFile('bad', 'data:image/jpeg,QUJD')).toBeNull();
  });

  it('cachedAvatarInfo：web 无持久缓存恒返回 null', async () => {
    await saveAvatarFile('main', 'data:image/jpeg;base64,QUJD');
    expect(await cachedAvatarInfo('main')).toBeNull();
  });
});
