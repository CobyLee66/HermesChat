/**
 * BusyTicker — busy 状态条的动态占位：官方 dashboard 同款 FaceTicker
 * （颜文字与动词独立随机起始，每 TICK_MS 各自 +1 顺序轮换），样式沿用
 * 状态条文本（12px / textSecondary）。
 */

import React, {useEffect, useState} from 'react';
import {StyleSheet, Text} from 'react-native';

import {Colors} from './theme';
import {FACES, TICK_MS, tickerText, VERBS} from '../utils/busyTicker';

export function BusyTicker() {
  const [faceIdx, setFaceIdx] = useState(() =>
    Math.floor(Math.random() * FACES.length),
  );
  const [verbIdx, setVerbIdx] = useState(() =>
    Math.floor(Math.random() * VERBS.length),
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setFaceIdx(i => (i + 1) % FACES.length);
      setVerbIdx(i => (i + 1) % VERBS.length);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return <Text style={styles.text}>{tickerText(faceIdx, verbIdx)}</Text>;
}

const styles = StyleSheet.create({
  text: {fontSize: 12, color: Colors.textSecondary},
});
