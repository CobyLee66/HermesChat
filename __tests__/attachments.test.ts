/**
 * 聊天附件测试：待发横条 add/remove、file.attach、带图发送。
 * rpc 全部 mock（image.attach_bytes / image.detach / file.attach 均为写操作，
 * 不打真实服务）；原生模块（RNFS / image-resizer）走 __mocks__ 自动 mock。
 */

import ImageResizer from '@bam.tech/react-native-image-resizer';
import RNFS from 'react-native-fs';

import {fileDownloadUrl} from '../src/rpc/rest';
import {_resetChatAggregators, useChatStore} from '../src/store/chat';
import type {UserMsg} from '../src/rpc/types';

const mockCall = jest.fn<Promise<unknown>, [string, Record<string, unknown>?]>();

jest.mock('../src/rpc/runtime', () => ({
  getRpc: () => ({call: mockCall}),
  setRpc: jest.fn(),
  hasRpc: () => true,
}));

const createResizedImage = ImageResizer.createResizedImage as jest.Mock;
const readFile = RNFS.readFile as jest.Mock;

function resetState() {
  _resetChatAggregators();
  useChatStore.setState({bySession: {}});
  mockCall.mockReset();
  createResizedImage.mockClear();
  readFile.mockClear();
}

describe('chat store 附件', () => {
  beforeEach(resetState);

  it('attachImages：压缩（2048/JPEG/80）后 image.attach_bytes，进待发横条', async () => {
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'image.attach_bytes') {
        return {
          attached: true,
          path: '/home/u/.hermes/images/upload_1.jpg',
          count: 1,
          name: 'upload_1.jpg',
        };
      }
      throw new Error(`unexpected rpc: ${method}`);
    });
    readFile.mockResolvedValue('aGk=');

    await useChatStore
      .getState()
      .attachImages('s1', [{uri: 'file:///tmp/photo.png', name: 'photo.png'}]);

    // 压缩参数：长边 2048、JPEG、quality 80
    expect(createResizedImage).toHaveBeenCalledWith(
      'file:///tmp/photo.png',
      2048,
      2048,
      'JPEG',
      80,
      0,
      undefined,
      false,
      {mode: 'contain', onlyScaleDown: true},
    );
    // 内容已转 JPEG → 文件名后缀改 .jpg（服务端扩展名优先采信文件名）
    expect(mockCall).toHaveBeenCalledWith('image.attach_bytes', {
      session_id: 's1',
      content_base64: 'aGk=',
      filename: 'photo.jpg',
    });
    const st = useChatStore.getState().bySession.s1;
    expect(st.pendingAttachments).toHaveLength(1);
    expect(st.pendingAttachments[0]).toEqual({
      path: '/home/u/.hermes/images/upload_1.jpg',
      localUri: 'file:///tmp/caches/resized.jpg',
      name: 'upload_1.jpg',
    });
  });

  it('attachImages 单张失败：时间线记错误条，不影响其余', async () => {
    let n = 0;
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'image.attach_bytes') {
        n += 1;
        if (n === 1) {
          throw new Error('image too large');
        }
        return {attached: true, path: '/p/2.jpg', count: 1};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });

    await useChatStore.getState().attachImages('s1', [
      {uri: 'file:///tmp/1.png', name: '1.png'},
      {uri: 'file:///tmp/2.png', name: '2.png'},
    ]);

    const st = useChatStore.getState().bySession.s1;
    expect(st.pendingAttachments).toHaveLength(1);
    expect(st.pendingAttachments[0].path).toBe('/p/2.jpg');
    expect(
      st.items.some(
        i => i.kind === 'system' && i.text.includes('图片上传失败'),
      ),
    ).toBe(true);
  });

  it('removeAttachment：横条移除 + image.detach', async () => {
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'image.attach_bytes') {
        return {attached: true, path: '/p/1.jpg', count: 1};
      }
      if (method === 'image.detach') {
        return {detached: true, count: 0};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });

    await useChatStore
      .getState()
      .attachImages('s1', [{uri: 'file:///tmp/1.png', name: '1.png'}]);
    await useChatStore.getState().removeAttachment('s1', '/p/1.jpg');

    expect(mockCall).toHaveBeenCalledWith('image.detach', {
      session_id: 's1',
      path: '/p/1.jpg',
    });
    expect(useChatStore.getState().bySession.s1.pendingAttachments).toEqual([]);
  });

  it('attachFile：file.attach 传 data_url，返回 @file: 引用文本', async () => {
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'file.attach') {
        return {
          attached: true,
          name: '报表.pdf',
          path: '/w/attachments/报表.pdf',
          ref_path: 'attachments/报表.pdf',
          ref_text: '@file:attachments/报表.pdf',
          uploaded: true,
        };
      }
      throw new Error(`unexpected rpc: ${method}`);
    });
    readFile.mockResolvedValue('UEQ=');

    const ref = await useChatStore.getState().attachFile('s1', {
      uri: 'file:///tmp/报表.pdf',
      name: '报表.pdf',
      mimeType: 'application/pdf',
    });

    expect(mockCall).toHaveBeenCalledWith('file.attach', {
      session_id: 's1',
      data_url: 'data:application/pdf;base64,UEQ=',
      name: '报表.pdf',
    });
    expect(ref).toBe('@file:attachments/报表.pdf');
  });

  it('带待发图片发送：空文本也提交 prompt.submit，回显带图，横条清空', async () => {
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'image.attach_bytes') {
        return {attached: true, path: '/p/1.jpg', count: 1};
      }
      if (method === 'prompt.submit') {
        return {status: 'streaming'};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });

    await useChatStore
      .getState()
      .attachImages('s1', [{uri: 'file:///tmp/1.png', name: '1.png'}]);
    await useChatStore.getState().sendPrompt('s1', '   ');

    expect(mockCall).toHaveBeenCalledWith('prompt.submit', {
      session_id: 's1',
      text: '',
    });
    const st = useChatStore.getState().bySession.s1;
    expect(st.pendingAttachments).toEqual([]);
    expect(st.busy).toBe(true);
    const userMsg = st.items.find(i => i.kind === 'user') as UserMsg;
    expect(userMsg.text).toBe('');
    expect(userMsg.images).toEqual([{path: '/p/1.jpg'}]);
  });

  it('无文本且无待发图片：sendPrompt 不发 RPC', async () => {
    await useChatStore.getState().sendPrompt('s1', '  ');
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('文本里的 @file: 引用在回显时剥离成文件卡片', async () => {
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'prompt.submit') {
        return {status: 'streaming'};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });

    await useChatStore
      .getState()
      .sendPrompt('s1', '分析这个文件 @file:attachments/报表.pdf');

    const st = useChatStore.getState().bySession.s1;
    const userMsg = st.items.find(i => i.kind === 'user') as UserMsg;
    expect(userMsg.text).toBe('分析这个文件');
    expect(userMsg.files).toEqual([
      {ref: 'attachments/报表.pdf', name: '报表.pdf'},
    ]);
  });
});

describe('fileDownloadUrl', () => {
  it('path 与 token 均 URI 编码，走 download 路由（stream 只放行音视频）', () => {
    expect(fileDownloadUrl('http://127.0.0.1:9119', '/a b/c.png', 'tok en')).toBe(
      'http://127.0.0.1:9119/api/files/download?path=%2Fa%20b%2Fc.png&token=tok%20en',
    );
  });

  it('无 token 时不带 token 参数', () => {
    expect(fileDownloadUrl('http://h', '/a.png', '')).toBe(
      'http://h/api/files/download?path=%2Fa.png',
    );
  });
});
