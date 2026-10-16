import React from 'react';
import {Image, Modal, Platform, TouchableOpacity} from 'react-native';
import {SafeAreaInsetsContext} from 'react-native-safe-area-context';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';

import {ChatImage} from '../src/components/ChatImage';
import {ImageViewer} from '../src/components/ImageViewer';
import {useConnectionStore} from '../src/store/connection';

const INSETS = {top: 20, right: 0, bottom: 0, left: 0};
const realOS = Platform.OS;

function viewer(onClose: () => void, uri = 'data:image/png;base64,aGVsbG8=') {
  return (
    <SafeAreaInsetsContext.Provider value={INSETS}>
      <ImageViewer uri={uri} onClose={onClose} />
    </SafeAreaInsetsContext.Provider>
  );
}

function closeButton(tree: ReactTestRenderer) {
  const node = tree.root
    .findAllByType(TouchableOpacity)
    .find(n => n.props.accessibilityLabel === '关闭');
  if (!node) {
    throw new Error('找不到关闭按钮');
  }
  return node;
}

afterEach(() => {
  (Platform as unknown as {OS: string}).OS = realOS;
});

it('缩略图点击传出带 token 编码的原图下载 URL', () => {
  useConnectionStore.setState({httpUrl: 'http://gateway', token: 'tok en'});
  const onPreview = jest.fn();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <ChatImage image={{path: '/a b/photo.png'}} onPreview={onPreview} />,
    );
  });
  const thumbnail = tree.root
    .findAllByType(TouchableOpacity)
    .find(n => n.props.accessibilityLabel === '查看原图');
  expect(thumbnail).toBeDefined();

  act(() => thumbnail!.props.onPress({}));

  expect(onPreview).toHaveBeenCalledWith(
    'http://gateway/api/files/download?path=%2Fa%20b%2Fphoto.png&token=tok%20en',
  );
});

it('全屏层用原 URI + contain 显示，关闭按钮和系统返回均可关闭', () => {
  const onClose = jest.fn();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(viewer(onClose));
  });
  const full = tree.root
    .findAllByType(Image)
    .find(n => n.props.testID === 'image-viewer-full');
  expect(full?.props.source).toEqual({uri: 'data:image/png;base64,aGVsbG8='});
  expect(full?.props.resizeMode).toBe('contain');

  act(() => closeButton(tree).props.onPress());
  act(() => tree.root.findByType(Modal).props.onRequestClose());

  expect(onClose).toHaveBeenCalledTimes(2);
});

it('web Escape 关闭并卸载键盘监听', () => {
  type KeyEvent = {key?: string; preventDefault?: () => void};
  type KeyListener = (ev: KeyEvent) => void;
  const listeners = new Set<KeyListener>();
  const globalWithWindow = globalThis as {window?: unknown};
  const previousWindow = globalWithWindow.window;
  globalWithWindow.window = {
    addEventListener: (type: string, listener: unknown) => {
      if (type === 'keydown') {
        listeners.add(listener as KeyListener);
      }
    },
    removeEventListener: (type: string, listener: unknown) => {
      if (type === 'keydown') {
        listeners.delete(listener as KeyListener);
      }
    },
  };
  (Platform as unknown as {OS: string}).OS = 'web';
  const onClose = jest.fn();
  let tree!: ReactTestRenderer;
  try {
    act(() => {
      tree = create(viewer(onClose));
    });
    expect(listeners.size).toBe(1);
    const preventDefault = jest.fn();

    act(() => {
      for (const listener of listeners) {
        listener({key: 'Escape', preventDefault});
      }
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
    expect(listeners.size).toBe(0);
  } finally {
    if (previousWindow === undefined) {
      delete globalWithWindow.window;
    } else {
      globalWithWindow.window = previousWindow;
    }
  }
});
