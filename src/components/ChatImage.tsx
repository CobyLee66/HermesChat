import React from 'react';
import {Image, StyleSheet} from 'react-native';

import type {ImageRef} from '../rpc/types';
import {fileDownloadUrl} from '../rpc/rest';
import {useConnectionStore} from '../store/connection';
import {Colors} from './theme';

interface Props {
  image: ImageRef;
}

/**
 * 聊天图片：data:/http(s): URI 直接用；gateway 绝对路径走
 * /api/files/download?path=…&token=…（/api/files/stream 只放行音视频，图片会 415）。
 */
export function ChatImage({image}: Props) {
  const httpUrl = useConnectionStore(s => s.httpUrl);
  const token = useConnectionStore(s => s.token);
  const uri =
    image.uri ?? (image.path ? fileDownloadUrl(httpUrl, image.path, token) : null);
  if (!uri) {
    return null;
  }
  return <Image source={{uri}} style={styles.img} resizeMode="cover" />;
}

const styles = StyleSheet.create({
  img: {
    width: 200,
    height: 150,
    borderRadius: 10,
    marginTop: 4,
    backgroundColor: Colors.border,
  },
});
