package com.hermeschat.keepalive

import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * HermesKeepAlive — 前台保活服务的 JS 桥（契约见 docs/ssh-module.md §7）。
 * start/stop 均幂等：重复 start 仅刷新通知文案；stop 在服务未运行时同样成功。
 */
class HermesKeepAliveModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "HermesKeepAlive"
    private const val E_KEEPALIVE_FAILED = "E_KEEPALIVE_FAILED"
  }

  override fun getName(): String = NAME

  @ReactMethod
  fun start(title: String, body: String, promise: Promise) {
    try {
      val intent = HermesKeepAliveService.startIntent(reactContext, title, body)
      // ContextCompat 内部按版本分发 startForegroundService/startService
      ContextCompat.startForegroundService(reactContext, intent)
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject(E_KEEPALIVE_FAILED, e.message ?: "start keep-alive failed", e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      // 服务未运行时返回 false，视为成功（幂等）
      reactContext.stopService(HermesKeepAliveService.stopIntent(reactContext))
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject(E_KEEPALIVE_FAILED, e.message ?: "stop keep-alive failed", e)
    }
  }
}
