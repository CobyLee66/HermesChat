/**
 * 通用图标组件：渲染 assets/icons.ts 里的 data URI PNG 并用 tintColor 着色。
 * 全项目无图标库/无 react-native-svg，位图 data URI 是原生与 web 通吃的零依赖方案。
 */

import React from 'react';
import {Image, ImageStyle, StyleProp} from 'react-native';

import {iconDataUri, IconName} from '../assets/icons';
import {Colors} from './theme';

interface Props {
  name: IconName;
  /** 显示边长（正方形），默认 24 */
  size?: number;
  /** 着色，默认次级文字色 */
  color?: string;
  style?: StyleProp<ImageStyle>;
}

export function IconImage({name, size = 24, color = Colors.textSecondary, style}: Props) {
  return (
    <Image
      source={{uri: iconDataUri(name)}}
      style={[{width: size, height: size, tintColor: color}, style]}
      resizeMode="contain"
    />
  );
}
