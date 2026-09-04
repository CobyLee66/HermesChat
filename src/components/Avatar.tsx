import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Animated, StyleSheet, Text, View} from 'react-native';

import {avatarColor} from './theme';

interface Props {
  name: string;
  /** 可直接喂 Image 的 URI（本地 file:// 缓存或 data URL 回退）；空则昵称首字符色块 */
  uri?: string | null;
  size?: number;
}

/** QQ 风格圆角头像：色块垫底，图片解码完成后 120ms 渐现，避免重挂载解码期的空白闪烁。 */
export function Avatar({name, uri, size = 44}: Props) {
  const radius = Math.round(size * 0.22);
  const [loaded, setLoaded] = useState(false);
  const fade = useRef(new Animated.Value(0)).current;
  // 稳定 source 引用，避免父组件重渲染时触发无谓的图片重载
  const source = useMemo(() => (uri ? {uri} : null), [uri]);

  useEffect(() => {
    // uri 变化（重新上传等）时重置渐现
    setLoaded(false);
    fade.setValue(0);
  }, [fade, uri]);

  useEffect(() => {
    if (loaded) {
      return;
    }
    // 兜底：防个别平台 onLoad 丢失导致头像永不显示
    const timer = setTimeout(() => setLoaded(true), 300);
    return () => clearTimeout(timer);
  }, [loaded]);

  useEffect(() => {
    if (loaded) {
      Animated.timing(fade, {
        toValue: 1,
        duration: 120,
        useNativeDriver: true,
      }).start();
    }
  }, [fade, loaded]);

  const initial = (name || '?').trim().charAt(0) || '?';
  return (
    <View
      style={[
        styles.block,
        {
          width: size,
          height: size,
          borderRadius: radius,
          backgroundColor: avatarColor(name),
        },
      ]}>
      {source ? (
        <Animated.Image
          source={source}
          fadeDuration={0}
          style={[styles.img, {borderRadius: radius, opacity: fade}]}
          onLoad={() => setLoaded(true)}
        />
      ) : (
        <Text style={[styles.initial, {fontSize: size * 0.42}]}>{initial}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  img: {
    width: '100%',
    height: '100%',
  },
  initial: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
});
