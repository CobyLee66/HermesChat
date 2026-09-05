import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Animated, StyleSheet, Text, View} from 'react-native';

import {avatarColor} from './theme';

interface Props {
  name: string;
  /** 可直接喂 Image 的 URI（本地 file:// 缓存或 data URL 回退）；空则昵称首字符色块 */
  uri?: string | null;
  size?: number;
}

/**
 * QQ 风格圆角头像：色块垫底。本地 file:// 缓存挂载即不透明呈现——原生管线按 URI
 * 命中内存位图缓存，加载零开销，渐现反而把瞬时呈现伪装成「加载中」（切会话过滤档
 * / 重进列表时行会重挂载，每次重播动画就是肉眼可见的「头像刷新」）；仅 data URL
 * 回退（RNFS 落盘失败 / web 端）保留 120ms 渐现柔化解码空窗。
 */
export function Avatar({name, uri, size = 44}: Props) {
  const radius = Math.round(size * 0.22);
  const isInstant = uri?.startsWith('file://') ?? false;
  const [loaded, setLoaded] = useState(isInstant);
  const fade = useRef(new Animated.Value(isInstant ? 1 : 0)).current;
  // 稳定 source 引用，避免父组件重渲染时触发无谓的图片重载
  const source = useMemo(() => (uri ? {uri} : null), [uri]);

  useEffect(() => {
    // uri 变化（首次拿到头像 / 重新上传等）时按回退类型重置
    setLoaded(isInstant);
    fade.setValue(isInstant ? 1 : 0);
  }, [fade, isInstant, uri]);

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
