/**
 * web 打桩：react-native-audio-recorder-player（vite alias，仅 web 构建使用）。
 * 浏览器录音链路（m4a + RNFS 落盘）不可用：方法一律 reject，VoiceButton 有 catch 兜底。
 * 默认导出实例形态与真包一致（VoiceButton 直接调用静态风格方法）。
 */

export const AudioSourceAndroidType = {MIC: 1} as const;
export const OutputFormatAndroidType = {MPEG_4: 2} as const;
export const AudioEncoderAndroidType = {AAC: 3} as const;

function unavailable(method: string): Promise<never> {
  return Promise.reject(
    new Error(`浏览器环境不支持录音（${method}），请在手机上使用语音输入`),
  );
}

class AudioRecorderPlayerStub {
  startRecorder(): Promise<string> {
    return unavailable('startRecorder');
  }
  stopRecorder(): Promise<string> {
    return unavailable('stopRecorder');
  }
  startPlayer(): Promise<string> {
    return unavailable('startPlayer');
  }
  stopPlayer(): Promise<string> {
    return unavailable('stopPlayer');
  }
  addRecordBackListener(): void {
    // no-op
  }
  removeRecordBackListener(): void {
    // no-op
  }
  addPlayBackListener(): void {
    // no-op
  }
  removePlayBackListener(): void {
    // no-op
  }
}

const AudioRecorderPlayer = new AudioRecorderPlayerStub();
export default AudioRecorderPlayer;
