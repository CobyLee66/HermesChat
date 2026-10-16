import React from 'react';
import {Image, StyleSheet, TouchableOpacity} from 'react-native';

import {useT} from '../i18n';
import type {ImageRef} from '../rpc/types';
import {fileDownloadUrl} from '../rpc/rest';
import {useConnectionStore} from '../store/connection';
import {expandToggleProps} from '../utils/expandPress';
import {Colors} from './theme';

interface Props {
  image: ImageRef;
  onPreview: (uri: string) => void;
}

/**
 * 聊天图片：data:/http(s): URI 直接用；gateway 绝对路径走
 * /api/files/download?path=…&token=…（/api/files/stream 只放行音视频，图片会 415）。
 * 缩略图点击后把同一原始 URI 交给全屏查看层。
 */
export function ChatImage({image, onPreview}: Props) {
  const httpUrl = useConnectionStore(s => s.httpUrl);
  const token = useConnectionStore(s => s.token);
  const t = useT();
  const uri =
    image.uri ?? (image.path ? fileDownloadUrl(httpUrl, image.path, token) : null);
  if (!uri) {
    return null;
  }
  return (
    <TouchableOpacity
      style={styles.touchable}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={t('chat.viewImage')}
      {...expandToggleProps(() => onPreview(uri))}>
      <Image source={{uri}} style={styles.img} resizeMode="cover" />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  touchable: {borderRadius: 10},
  img: {
    width: 200,
    height: 150,
    borderRadius: 10,
    marginTop: 4,
    backgroundColor: Colors.border,
  },
});
