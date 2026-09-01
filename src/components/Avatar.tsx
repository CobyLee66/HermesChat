import React from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';

import {avatarColor} from './theme';

interface Props {
  name: string;
  /** data URL（profiles.get_asset 返回）；空则昵称首字符色块 */
  uri?: string | null;
  size?: number;
}

/** QQ 风格圆角头像：有图显示图，无图用昵称首字符色块。 */
export function Avatar({name, uri, size = 44}: Props) {
  const radius = Math.round(size * 0.22);
  if (uri) {
    return (
      <Image
        source={{uri}}
        style={{width: size, height: size, borderRadius: radius}}
      />
    );
  }
  const initial = (name || '?').trim().charAt(0) || '?';
  return (
    <View
      style={[
        styles.block,
        {width: size, height: size, borderRadius: radius, backgroundColor: avatarColor(name)},
      ]}>
      <Text style={[styles.initial, {fontSize: size * 0.42}]}>{initial}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  initial: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
});
