import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Animated, StyleSheet, Text, View} from 'react-native';

import {avatarColor} from './theme';

interface Props {
  name: string;
  /** 可直接喂 Image 的 URI（确定性缓存路径 file:// / blob: 优先，data URL 回退）；空则昵称首字符色块 */
  uri?: string | null;
  size?: number;
}

/**
 * QQ 风格圆角头像：色块垫底。确定性缓存路径挂载即不透明呈现——原生 file:// 落盘
 * （管线按 URI 命中内存位图）与 web/桌面 blob: object URL（浏览器按 URL 命中内存
 * 缓存）加载零开销，渐现反而把瞬时呈现伪装成「加载中」（切会话过滤档 / 切 profile
 * / 重进列表时行会重挂载或换 uri，每次重播动画就是肉眼可见的「头像刷新」）；仅
 * data URL 回退（落盘/转换失败）保留 120ms 渐现柔化解码空窗。
 *
 * 圆角只允许一层且**图片分支不得垫底色**：圆角收敛在 Image 自身（无图回退分支
 * 在外层 View）。两个历史教训（2026-09-09 像素级定因，D036）：①外层 View 与内层
 * Image 同时设 borderRadius 会在 Android 触发双层抗锯齿接缝；②Image 下垫
 * avatarColor 底色会从圆角裁剪的抗锯齿边缘渗出，在白底头像四周形成一圈彩色
 * 「瑕疵线框」（三端真实 GPU 窗口均可见，无头截图/灰度分析会漏掉，须查色度）。
 */
export function Avatar({name, uri, size = 44}: Props) {
  const radius = Math.round(size * 0.22);
  const isInstant =
    uri?.startsWith('file://') === true || uri?.startsWith('blob:') === true;
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
  const fallbackBlock = {
    width: size,
    height: size,
    borderRadius: radius,
    backgroundColor: avatarColor(name),
  };
  return (
    <View
      style={[styles.block, {width: size, height: size}, !source && fallbackBlock]}>
      {source ? (
        <Animated.Image
          source={source}
          fadeDuration={0}
          style={[
            styles.img,
            {borderRadius: radius, opacity: fade},
          ]}
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
