/**
 * 语音输入按钮（附件面板里的一格）：点一次开始录音，再点停止并转文字。
 * 录音产物 m4a → base64 → POST /api/audio/transcribe → 识别文本回调给输入框。
 * Android 运行时权限用 PermissionsAndroid 申请 RECORD_AUDIO。
 */

import React, {useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
} from 'react-native';
import * as HermesAudio from '../ssh/HermesAudio';
import RNFS from 'react-native-fs';

import {transcribeAudio} from '../rpc/rest';
import {useConnectionStore} from '../store/connection';
import {IconImage} from './icons';
import {Colors} from './theme';

type Phase = 'idle' | 'recording' | 'busy';

/**
 * 整个「停止→转文字」流程的兜底超时。REST 层已有 30s fetch 超时（rest.ts），
 * 这里再兜住原生 stopRecording / RNFS.readFile 极端挂起的情况，
 * 保证 finally 必定执行，界面不会永远停在「识别中」。
 */
const BUSY_TIMEOUT_MS = 35_000;

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

function timeoutReject(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error(`语音识别超时（${Math.round(ms / 1000)} 秒），请重试`)),
      ms,
    );
  });
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
      HermesAudio.stopRecording().catch(() => {});
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
    await HermesAudio.startRecording(path);
    setSecs(0);
    setPhase('recording');
    timerRef.current = setInterval(() => setSecs(s => s + 1), 1000);
  };

  const stopAndTranscribe = () => {
    clearTimer();
    setPhase('busy');
    const path = pathRef.current;
    (async () => {
      try {
        await Promise.race([
          (async () => {
            await HermesAudio.stopRecording();
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
          })(),
          timeoutReject(BUSY_TIMEOUT_MS),
        ]);
      } catch (e) {
        Alert.alert('语音识别失败', e instanceof Error ? e.message : String(e));
      } finally {
        if (path) {
          RNFS.unlink(path).catch(() => {});
        }
        setPhase('idle');
      }
    })();
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

  return (
    <TouchableOpacity
      style={styles.tile}
      onPress={onPress}
      disabled={phase === 'busy'}
      activeOpacity={0.7}
      accessibilityLabel="语音输入">
      {phase === 'idle' ? (
        <IconImage name="microphone" size={26} />
      ) : phase === 'recording' ? (
        <>
          <IconImage name="player-stop" size={26} color={Colors.danger} />
          <Text style={styles.subLabel}>{secs}s</Text>
        </>
      ) : (
        <>
          <ActivityIndicator size="small" color={Colors.textSecondary} />
          <Text style={[styles.subLabel, styles.subLabelMuted]}>识别中…</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

/** 面板三格统一 56 高：录音秒数/识别中的小字多出来的高度不挤动面板。 */
const styles = StyleSheet.create({
  tile: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 88,
    height: 56,
  },
  subLabel: {fontSize: 12, color: Colors.danger, fontWeight: '600', marginTop: 2},
  subLabelMuted: {color: Colors.textSecondary, fontWeight: '400'},
});
