import React from 'react';
import {TouchableOpacity} from 'react-native';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';

import {ChatInputBar} from '../src/panels/ChatInputBar';
import {useChatStore} from '../src/store/chat';
import {useConnectionStore} from '../src/store/connection';

jest.mock('@react-native-documents/picker', () => ({
  pick: jest.fn(),
  keepLocalCopy: jest.fn(),
  types: {images: 'images', allFiles: 'allFiles'},
  errorCodes: {OPERATION_CANCELED: 'cancelled'},
  isErrorWithCode: () => false,
}));
jest.mock('../src/components/VoiceButton', () => ({VoiceButton: () => null}));
jest.mock('../src/utils/useKeyboardHeight', () => ({
  useKeyboardHeight: () => ({height: 0, bottomPad: 0}),
}));

type ImagePick = {uri: string; name?: string | null; mimeType?: string | null};
const mockAttachImages = jest.fn<
  Promise<void>,
  [string, ImagePick[], {original?: boolean}?]
>();
const mockPickImages = jest.fn<Promise<ImagePick[]>, []>();
const realAttachImages = useChatStore.getState().attachImages;
const picked: ImagePick = {
  uri: 'file:///tmp/photo.png',
  name: 'photo.png',
  mimeType: 'image/png',
};

function touchable(tree: ReactTestRenderer, label: string) {
  const node = tree.root
    .findAllByType(TouchableOpacity)
    .find(n => n.props.accessibilityLabel === label);
  if (!node) {
    throw new Error(`找不到按钮：${label}`);
  }
  return node;
}

beforeEach(() => {
  mockAttachImages.mockReset().mockResolvedValue(undefined);
  mockPickImages.mockReset().mockResolvedValue([picked]);
  useChatStore.setState({bySession: {}, attachImages: mockAttachImages});
  useConnectionStore.setState({state: 'ready'});
});

afterAll(() => {
  useChatStore.setState({attachImages: realAttachImages});
});

it('同一图片入口按“原图”复选框切换上传模式', async () => {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <ChatInputBar
        sessionId="s1"
        profile="main"
        input=""
        onInputChange={() => {}}
        onSend={() => {}}
        attachPanelOpen
        onAttachPanelChange={() => {}}
        pickers={{pickImages: mockPickImages, pickFile: async () => null}}
      />,
    );
  });

  await act(async () => {
    await touchable(tree, '发送图片').props.onPress();
  });
  expect(mockAttachImages).toHaveBeenNthCalledWith(1, 's1', [picked], {
    original: false,
  });

  act(() => touchable(tree, '原图').props.onPress());
  expect(touchable(tree, '原图').props.accessibilityState).toEqual({checked: true});

  await act(async () => {
    await touchable(tree, '发送图片').props.onPress();
  });
  expect(mockAttachImages).toHaveBeenNthCalledWith(2, 's1', [picked], {
    original: true,
  });
  expect(mockPickImages).toHaveBeenCalledTimes(2);
  await act(async () => tree.unmount());
});
