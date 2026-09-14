/**
 * web 变体（vite resolve.extensions 让 .web.tsx 优先；Metro 默认平台不含 web，
 * 原生构建仍用 VoiceButton.tsx，tsc 类型检查也以原文件为准）。
 * - Electron 桌面（window.hermesDesktop 存在）：getUserMedia + MediaRecorder
 *   直录（浏览器标准 API，无需原生模块）→ data URL → 转写，交互与手机一致。
 * - 普通浏览器：无录音链路，渲染禁用态占位（保持附件面板布局一致）。
 */

import React, {useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import {transcribeAudio} from '../rpc/rest';
import {t, useT} from '../i18n';
import {getDesktopBridge} from '../ssh/desktopHermesSsh';
import {useConnectionStore} from '../store/connection';
import {alertError} from '../utils/alert';
import {IconImage} from './icons';
import {Colors} from './theme';

interface Props {
  profile: string;
  onText: (text: string) => void;
}

type Phase = 'idle' | 'recording' | 'busy';

/** 整体兜底超时（对齐原生版，REST 层另有 30s fetch 超时） */
const BUSY_TIMEOUT_MS = 35_000;

// 无 DOM lib：录音相关全局用结构类型
interface WebMediaRecorder {
  ondataavailable: ((e: {data: Blob}) => void) | null;
  onstop: (() => void) | null;
  start: () => void;
  stop: () => void;
}
type WebRecorderCtor = new (
  stream: unknown,
  opts?: {mimeType?: string},
) => WebMediaRecorder;
interface WebMediaStream {
  getTracks: () => {stop: () => void}[];
}

/** 依次取第一个受支持的录音容器（mp4/aac 优先，服务端 ffmpeg 均可解） */
function pickRecorderMime(): string | undefined {
  const ctor = (globalThis as {
    MediaRecorder?: {isTypeSupported?: (t: string) => boolean};
  }).MediaRecorder;
  if (!ctor?.isTypeSupported) {
    return undefined;
  }
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  return candidates.find(t => ctor.isTypeSupported!(t));
}

function timeoutReject(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(
      () =>
        reject(
          new Error(
            t('voice.recognizeTimeout', {seconds: Math.round(ms / 1000)}),
          ),
        ),
      ms,
    );
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(t('voice.readFailed')));
    reader.readAsDataURL(blob);
  });
}

export function VoiceButton({profile, onText}: Props) {
  const t = useT();
  const desktop = getDesktopBridge() != null;
  const [phase, setPhase] = useState<Phase>('idle');
  const [secs, setSecs] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recorderRef = useRef<WebMediaRecorder | null>(null);
  const streamRef = useRef<WebMediaStream | null>(null);
  const mimeRef = useRef<string>('');
  const chunksRef = useRef<Blob[]>([]);

  function clearTimer() {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  // 卸载兜底：停录音、清定时器、释放麦克风
  useEffect(() => {
    return () => {
      clearTimer();
      try {
        recorderRef.current?.stop();
        streamRef.current?.getTracks().forEach(t => t.stop());
      } catch {
        // ignore
      }
    };
  }, []);

  const start = async () => {
    const nav = (globalThis as {
      navigator?: {
        mediaDevices?: {getUserMedia?: (c: unknown) => Promise<WebMediaStream>};
      };
    }).navigator;
    const Ctor = (globalThis as {MediaRecorder?: WebRecorderCtor}).MediaRecorder;
    if (!nav?.mediaDevices?.getUserMedia || !Ctor) {
      throw new Error(t('voice.micUnsupported'));
    }
    const stream = await nav.mediaDevices.getUserMedia({audio: true});
    const mimeType = pickRecorderMime();
    const recorder = mimeType ? new Ctor(stream, {mimeType}) : new Ctor(stream);
    chunksRef.current = [];
    recorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) {
        chunksRef.current.push(e.data);
      }
    };
    recorder.start();
    recorderRef.current = recorder;
    streamRef.current = stream;
    mimeRef.current = mimeType ?? '';
    setSecs(0);
    setPhase('recording');
    timerRef.current = setInterval(() => setSecs(s => s + 1), 1000);
  };

  const releaseMic = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
  };

  const stopAndTranscribe = () => {
    clearTimer();
    setPhase('busy');
    const recorder = recorderRef.current;
    const mimeType = mimeRef.current;
    (async () => {
      try {
        const dataUrl = await Promise.race([
          (async () => {
            const blob = await new Promise<Blob>((resolve, reject) => {
              if (!recorder) {
                reject(new Error(t('voice.recorderMissing')));
                return;
              }
              recorder.onstop = () => {
                // 项目无 DOM lib，Blob options 与 node 类型冲突，结构断言绕过
                const opts = {type: mimeType || 'audio/webm'} as never;
                resolve(new Blob(chunksRef.current, opts));
              };
              try {
                recorder.stop();
              } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
              }
            });
            releaseMic();
            return blobToDataUrl(blob);
          })(),
          timeoutReject(BUSY_TIMEOUT_MS),
        ]);
        const {httpUrl, token} = useConnectionStore.getState();
        const result = await transcribeAudio(httpUrl, token, dataUrl, profile);
        const text = result.transcript.trim();
        if (text) {
          onText(text);
        } else {
          alertError(t('voice.title'), t('voice.noSpeech'));
        }
      } catch (e) {
        alertError(
          t('voice.recognizeFailed'),
          e instanceof Error ? e.message : String(e),
        );
      } finally {
        setPhase('idle');
      }
    })();
  };

  if (!desktop) {
    // 普通浏览器：禁用态占位
    return (
      <View style={styles.tileDisabled}>
        <IconImage name="microphone" size={26} />
      </View>
    );
  }

  const onPress = () => {
    if (phase === 'idle') {
      start().catch(e => {
        setPhase('idle');
        alertError(
          t('voice.recordFailed'),
          e instanceof Error ? e.message : String(e),
        );
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
      accessibilityLabel={t('voice.title')}>
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
          <Text style={[styles.subLabel, styles.subLabelMuted]}>
            {t('voice.busy')}
          </Text>
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
  tileDisabled: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 88,
    height: 56,
    opacity: 0.35,
  },
  subLabel: {fontSize: 12, color: Colors.danger, fontWeight: '600', marginTop: 2},
  subLabelMuted: {color: Colors.textSecondary, fontWeight: '400'},
});
