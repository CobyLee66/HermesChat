package com.hermeschat.ssh

import android.media.MediaRecorder
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference

/**
 * HermesAudio — 极简录音模块（语音输入用），替代第三方录音库。
 *
 * 背景：react-native-audio-recorder-player 3.x（老 API 在 RN 0.87 上编译不过）
 * 和 4.x（Nitro 预生成代码与 nitro-modules 版本不兼容）都不可用，而需求面只有
 * start/stop 两个调用，故自研。MediaRecorder：MIC → MPEG_4/AAC（.m4a）。
 *
 * 权限（RECORD_AUDIO）由 JS 侧 PermissionsAndroid 先行申请，本模块不重复处理。
 */
class HermesAudioModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "HermesAudio"
    private const val E_BUSY = "E_BUSY"
    private const val E_NOT_RECORDING = "E_NOT_RECORDING"
    private const val E_START_FAILED = "E_START_FAILED"
    private const val E_STOP_FAILED = "E_STOP_FAILED"
  }

  private val executor: ExecutorService = Executors.newSingleThreadExecutor()
  private val recorderRef = AtomicReference<MediaRecorder?>(null)

  override fun getName(): String = NAME

  override fun invalidate() {
    runCatching { recorderRef.getAndSet(null)?.apply { reset(); release() } }
    super.invalidate()
  }

  @ReactMethod
  fun startRecording(path: String, promise: Promise) {
    executor.execute {
      if (recorderRef.get() != null) {
        promise.reject(E_BUSY, "已有录音在进行中")
        return@execute
      }
      try {
        File(path).parentFile?.mkdirs()
        @Suppress("DEPRECATION")
        val recorder =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(reactContext)
          } else {
            MediaRecorder()
          }
        recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
        recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        recorder.setAudioEncodingBitRate(96000)
        recorder.setAudioSamplingRate(44100)
        recorder.setOutputFile(path)
        recorder.prepare()
        recorder.start()
        recorderRef.set(recorder)
        promise.resolve(null)
      } catch (e: Throwable) {
        promise.reject(E_START_FAILED, e.message ?: "start failed", e)
      }
    }
  }

  /** 停止录音，resolve 输出文件路径；录音太短（无有效帧）时 reject。 */
  @ReactMethod
  fun stopRecording(promise: Promise) {
    executor.execute {
      val recorder = recorderRef.getAndSet(null)
      if (recorder == null) {
        promise.reject(E_NOT_RECORDING, "当前没有进行中的录音")
        return@execute
      }
      try {
        recorder.stop()
        recorder.reset()
        recorder.release()
        promise.resolve(null)
      } catch (e: Throwable) {
        // stop() 在几乎没录到内容时会抛 IllegalStateException，文件无效
        runCatching { recorder.reset() }
        runCatching { recorder.release() }
        promise.reject(E_STOP_FAILED, "录音太短或失败: ${e.message}", e)
      }
    }
  }
}
