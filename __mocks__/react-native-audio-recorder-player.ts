/** react-native-audio-recorder-player 的 jest mock（Nitro 模块，jest 下不可用）。 */
class MockAudioRecorderPlayer {
  startRecorder = jest.fn(async (uri?: string) => uri ?? 'ok');
  stopRecorder = jest.fn(async () => 'ok');
  pauseRecorder = jest.fn(async () => 'ok');
  resumeRecorder = jest.fn(async () => 'ok');
  startPlayer = jest.fn(async () => 'ok');
  stopPlayer = jest.fn(async () => 'ok');
  pausePlayer = jest.fn(async () => 'ok');
  resumePlayer = jest.fn(async () => 'ok');
  seekToPlayer = jest.fn(async () => 'ok');
  setVolume = jest.fn(async () => 'ok');
  setPlaybackSpeed = jest.fn(async () => 'ok');
  setSubscriptionDuration = jest.fn();
  addRecordBackListener = jest.fn();
  removeRecordBackListener = jest.fn();
  addPlayBackListener = jest.fn();
  removePlayBackListener = jest.fn();
  addPlaybackEndListener = jest.fn();
  removePlaybackEndListener = jest.fn();
  mmss = jest.fn((s: number) => String(s));
  mmssss = jest.fn((ms: number) => String(ms));
}

export const AudioSourceAndroidType = {DEFAULT: 0, MIC: 1};
export const OutputFormatAndroidType = {DEFAULT: 0, MPEG_4: 2};
export const AudioEncoderAndroidType = {DEFAULT: 0, AAC: 3};
export const AVEncoderAudioQualityIOSType = {min: 0, medium: 64, high: 96};

export default new MockAudioRecorderPlayer();
