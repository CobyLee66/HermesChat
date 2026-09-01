/**
 * 语音输入按钮（附件面板里的一格）：点一次开始录音，再点停止并转文字。
 * 录音产物 m4a → base64 → POST /api/audio/transcribe → 识别文本回调给输入框。
 * Android 运行时权限用 PermissionsAndroid 申请 RECORD_AUDIO。
 */

import React, {useEffect, useRef, useState} from 'react';
import {
  Alert,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
} from 'react-native';
import AudioRecorderPlayer, {
  AudioEncoderAndroidType,
  AudioSourceAndroidType,
  OutputFormatAndroidType,
} from 'react-native-audio-recorder-player';
import RNFS from 'react-native-fs';

import {transcribeAudio} from '../rpc/rest';
import {useConnectionStore} from '../store/connection';
import {Colors} from './theme';

type Phase = 'idle' | 'recording' | 'busy';

interface Props {
  /** 转文字时按会话 profile 走（?profile= 查询参数） */
  profile: string;
  /** 识别文本（空串=未识别到语音，不回调） */
  onText: (text: string) => void;
}

async function ensureRecordPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }
  const granted = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    {
      title: '录音权限',
      message: '语音输入需要使用麦克风',
      buttonPositive: '允许',
      buttonNegative: '拒绝',
    },
  );
  return granted === PermissionsAndroid.RESULTS.GRANTED;
}

export function VoiceButton({profile, onText}: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [secs, setSecs] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pathRef = useRef('');

  function clearTimer() {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  // 卸载兜底：停录音、清定时器、删临时文件
  useEffect(() => {
    return () => {
      clearTimer();
      AudioRecorderPlayer.stopRecorder().catch(() => {});
      if (pathRef.current) {
        RNFS.unlink(pathRef.current).catch(() => {});
      }
    };
  }, []);

  const start = async () => {
    if (!(await ensureRecordPermission())) {
      Alert.alert('无法录音', '请在系统设置中允许麦克风权限');
      return;
    }
    const path = `${RNFS.CachesDirectoryPath}/voice_${Date.now()}.m4a`;
    pathRef.current = path;
    await AudioRecorderPlayer.startRecorder(path, {
      AudioSourceAndroid: AudioSourceAndroidType.MIC,
      OutputFormatAndroid: OutputFormatAndroidType.MPEG_4,
      AudioEncoderAndroid: AudioEncoderAndroidType.AAC,
      AVEncodingOptionIOS: 'aac',
    });
    setSecs(0);
    setPhase('recording');
    timerRef.current = setInterval(() => setSecs(s => s + 1), 1000);
  };

  const stopAndTranscribe = async () => {
    clearTimer();
    setPhase('busy');
    const path = pathRef.current;
    try {
      await AudioRecorderPlayer.stopRecorder();
      const base64 = await RNFS.readFile(path, 'base64');
      const {httpUrl, token} = useConnectionStore.getState();
      const result = await transcribeAudio(
        httpUrl,
        token,
        `data:audio/m4a;base64,${base64}`,
        profile,
      );
      const text = result.transcript.trim();
      if (text) {
        onText(text);
      } else {
        Alert.alert('语音输入', '未识别到语音内容');
      }
    } catch (e) {
      Alert.alert('语音识别失败', e instanceof Error ? e.message : String(e));
    } finally {
      if (path) {
        RNFS.unlink(path).catch(() => {});
      }
      setPhase('idle');
    }
  };

  const onPress = () => {
    if (phase === 'idle') {
      start().catch(e => {
        setPhase('idle');
        Alert.alert('录音失败', e instanceof Error ? e.message : String(e));
      });
    } else if (phase === 'recording') {
      stopAndTranscribe();
    }
    // busy（识别中）：忽略点击
  };

  const label =
    phase === 'recording'
      ? `🔴 ${secs}s 点击停止`
      : phase === 'busy'
        ? '识别中…'
        : '语音输入';

  return (
    <TouchableOpacity
      style={styles.tile}
      onPress={onPress}
      disabled={phase === 'busy'}
      activeOpacity={0.7}>
      <Text style={styles.icon}>{phase === 'idle' ? '🎤' : ' '}</Text>
      <Text
        style={[styles.label, phase !== 'idle' && styles.labelActive]}
        numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  tile: {alignItems: 'center', width: 88, paddingVertical: 6},
  icon: {fontSize: 26, marginBottom: 4},
  label: {fontSize: 12, color: Colors.text},
  labelActive: {color: Colors.danger, fontWeight: '600'},
});
