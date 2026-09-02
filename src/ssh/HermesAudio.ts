/**
 * HermesAudio.ts — 录音原生模块的 JS wrapper（语音输入用）。
 * 原生实现：android/.../ssh/HermesAudioModule.kt（MediaRecorder → m4a/AAC）。
 * 模块缺失（web/Jest/未链接）时 isAvailable=false，方法 reject 而非抛同步异常。
 */

import {NativeModules} from 'react-native';

interface NativeHermesAudioModule {
  startRecording(path: string): Promise<void>;
  stopRecording(): Promise<void>;
}

const native: NativeHermesAudioModule | undefined = NativeModules.HermesAudio;

export const isAvailable = native != null;

/** 开始录音到指定文件路径（m4a）。权限由调用方先行申请。 */
export function startRecording(path: string): Promise<void> {
  if (!native) {
    return Promise.reject(new Error('HermesAudio native module is not available (startRecording)'));
  }
  return native.startRecording(path);
}

/** 停止录音。录音太短时 reject（E_STOP_FAILED）。 */
export function stopRecording(): Promise<void> {
  if (!native) {
    return Promise.reject(new Error('HermesAudio native module is not available (stopRecording)'));
  }
  return native.stopRecording();
}
