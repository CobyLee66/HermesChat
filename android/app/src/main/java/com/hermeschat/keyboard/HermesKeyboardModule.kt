package com.hermeschat.keyboard

import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

/**
 * HermesKeyboard — 键盘避让对账模块：查询 IME 实时可见性。
 *
 * 背景（D016/D050）：edge-to-edge + adjustNothing 下键盘避让由 JS 手动垫高，
 * 唯一收回路径是 RN 的 keyboardDidHide 事件；而该事件由 ReactRootView 的
 * global-layout 缓存状态机在「ime 可见→不可见」跳变时发出，agent 流式输出期间
 * 布局高密度失效，真机上会漏发，导致输入区 padding 卡在键盘高度不缩回。
 * adjustNothing 下 JS 侧没有键盘真实可见性可对账（Dimensions 不变、
 * Keyboard.isVisible 与事件同源缓存），故提供此原生查询：JS 在「键盘 believed-open」
 * 期间轮询，原生报不可见即收回垫高。
 */
class HermesKeyboardModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "HermesKeyboard"
  }

  override fun getName(): String = NAME

  /** IME 是否可见。Activity 不在前台（拿不到窗口）时按不可见处理。 */
  @ReactMethod
  fun isImeVisible(promise: Promise) {
    UiThreadUtil.runOnUiThread {
      val activity = reactContext.currentActivity
      val decorView: View? = activity?.window?.decorView
      val insets = decorView?.let { ViewCompat.getRootWindowInsets(it) }
      promise.resolve(insets?.isVisible(WindowInsetsCompat.Type.ime()) == true)
    }
  }
}
