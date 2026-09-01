package com.hermesmobile.ssh

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.jcraft.jsch.ChannelExec
import com.jcraft.jsch.JSch
import com.jcraft.jsch.JSchException
import com.jcraft.jsch.Session
import com.jcraft.jsch.UIKeyboardInteractive
import com.jcraft.jsch.UserInfo
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.locks.ReentrantLock

/**
 * HermesSsh — SSH 隧道原生模块（契约见 docs/ssh-module.md）。
 *
 * 关键设计：
 * - HostKey 策略：JSch 没有 StrictHostKeyChecking=accept-new，等价实现 =
 *   shkc="ask" + [AcceptNewUserInfo]（未知主机的 authenticity 提示自动接受，
 *   由 JSch 走 HostKeyRepository.add() 持久化；HOST IDENTIFICATION HAS CHANGED
 *   提示一律拒绝，fail closed）。known_hosts 存 app 私有目录
 *   filesDir/hermes_known_hosts。
 * - 线程模型：所有阻塞操作进 cached 线程池；每条 startCommand 通道一个 stdout
 *   读线程 + 一个 stderr 排空线程；exec 每条流一个读线程。connect/disconnect
 *   与状态切换在 [stateLock] 下串行。
 * - 断连探测：JSch setServerAliveInterval(15000) + setServerAliveCountMax(3)，
 *   keepalive 超时后 JSch 内部断开；watchdog 每 2s 轮询 session.isConnected，
 *   非主动断开时发 "HermesSsh:disconnect" {reason}。
 *
 * 存疑点（首次真机构建优先核对，均已在 mwiede/jsch jsch-0.2.18 源码中核实过签名）：
 * - Session.setPortForwardingL(bind, 0, host, rport) 依赖 PortWatcher 对
 *   lport==0 自动分配并回写实际端口（PortWatcher.bindLocalPort, 0.2.18 已确认）。
 * - session.hostKey 在 connect() 成功后非空（checkHost 内赋值）。
 * - OpenSSH 新格式私钥（BEGIN OPENSSH PRIVATE KEY）由 KeyPair.load 直接支持。
 */
class HermesSshModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "HermesSsh"

    private const val EVENT_STDOUT = "HermesSsh:stdout:"
    private const val EVENT_EXIT = "HermesSsh:exit:"
    private const val EVENT_DISCONNECT = "HermesSsh:disconnect"

    private const val E_NOT_CONNECTED = "E_NOT_CONNECTED"
    private const val E_CONNECT_FAILED = "E_CONNECT_FAILED"
    private const val E_EXEC_FAILED = "E_EXEC_FAILED"
    private const val E_EXEC_TIMEOUT = "E_EXEC_TIMEOUT"
    private const val E_CHANNEL_FAILED = "E_CHANNEL_FAILED"
    private const val E_FORWARD_FAILED = "E_FORWARD_FAILED"
    private const val E_NOT_AVAILABLE = "E_NOT_AVAILABLE"

    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val CHANNEL_OPEN_TIMEOUT_MS = 10_000
    private const val KEEPALIVE_INTERVAL_MS = 15_000
    private const val KEEPALIVE_COUNT_MAX = 3
    private const val WATCHDOG_INTERVAL_MS = 2_000L
    private const val EXIT_STATUS_GRACE_MS = 2_000L
    private const val MAX_STREAM_BYTES = 8 * 1024 * 1024

    private const val KNOWN_HOSTS_FILE = "hermes_known_hosts"
  }

  /** 所有阻塞 SSH 操作的工作线程池（daemon 线程，不阻止进程退出）。 */
  private val executor: ExecutorService = Executors.newCachedThreadPool { r ->
    Thread(r, "hermes-ssh-io").apply { isDaemon = true }
  }

  private val stateLock = ReentrantLock()

  @Volatile private var session: Session? = null

  /** 主动断开/从未连接时为 true；watchdog 只在上报过一次后置位，避免重复事件。 */
  @Volatile private var intentionalDisconnect = true

  @Volatile private var watchdog: ScheduledExecutorService? = null

  /** taskId -> 长驻 exec channel */
  private val tasks = ConcurrentHashMap<String, ChannelExec>()

  /** 已建立的本地转发端口（Session.disconnect() 会连带清理 PortWatcher）。 */
  private val localForwards = ConcurrentHashMap.newKeySet<Int>()

  override fun getName(): String = NAME

  // ---------------------------------------------------------------------------
  // NativeEventEmitter 兼容桩（RN 要求原生模块提供，否则 JS 侧告警）
  // ---------------------------------------------------------------------------

  @ReactMethod
  fun addListener(eventName: String) {
    // no-op
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    // no-op
  }

  // ---------------------------------------------------------------------------
  // connect / disconnect
  // ---------------------------------------------------------------------------

  @ReactMethod
  fun connect(config: ReadableMap, promise: Promise) {
    submit(promise) {
      stateLock.lock()
      val jsch = JSch() // 提到 try 外：catch 里做 Auth fail 诊断要用
      try {
        // 重复连接冲突：先静默断开旧会话（不触发 HermesSsh:disconnect）
        intentionalDisconnect = true
        disconnectLocked()

        val host = config.getStringOrNull("host")?.takeIf { it.isNotBlank() }
          ?: throw JSchException("connect: host is required")
        val username = config.getStringOrNull("username")?.takeIf { it.isNotBlank() }
          ?: throw JSchException("connect: username is required")
        val port = config.getIntOrNull("port") ?: 22
        val password = config.getStringOrNull("password")
        val privateKey = config.getStringOrNull("privateKey")
        val passphrase = config.getStringOrNull("passphrase")

        // known_hosts 落到 app 私有文件；文件不存在时 KnownHosts 会静默跳过读取、
        // 首次 add() 时创建（mwiede jsch KnownHosts.setKnownHosts/sync 行为）。
        jsch.setKnownHosts(File(reactContext.filesDir, KNOWN_HOSTS_FILE).absolutePath)

        if (!privateKey.isNullOrEmpty()) {
          // 私钥优先于密码（契约 §2）
          jsch.addIdentity(
            "hermes-mobile",
            privateKey.toByteArray(Charsets.UTF_8),
            null,
            passphrase?.toByteArray(Charsets.UTF_8)
          )
        }

        val newSession = jsch.getSession(username, host, port)
        if (password != null) {
          newSession.setPassword(password)
        }
        newSession.setConfig("StrictHostKeyChecking", "ask")
        newSession.userInfo = AcceptNewUserInfo(password)
        newSession.setServerAliveInterval(KEEPALIVE_INTERVAL_MS)
        newSession.setServerAliveCountMax(KEEPALIVE_COUNT_MAX)
        newSession.connect(CONNECT_TIMEOUT_MS)

        val fingerprint = newSession.hostKey?.getFingerPrint(jsch) ?: ""
        val clientKeyInfo = identitySummary(jsch)

        session = newSession
        intentionalDisconnect = false
        startWatchdog(newSession)

        val result = Arguments.createMap()
        result.putString("serverFingerprint", fingerprint)
        result.putString("clientKeyInfo", clientKeyInfo)
        promise.resolve(result)
      } catch (e: Throwable) {
        intentionalDisconnect = true
        disconnectLocked()
        // Auth fail 时附上已加载密钥的指纹/算法，方便和服务端 authorized_keys 对照
        val msg = e.message ?: "connect failed"
        val detail = if (msg.contains("Auth fail")) {
          val ids = runCatching { identitySummary(jsch) }.getOrDefault("读取失败")
          "$msg | 已加载密钥: ${ids.ifEmpty { "无（私钥未成功解析）" }}" +
            " | 请核对: 1) 用户名/端口 2) 密钥指纹是否与服务端 authorized_keys 一致"
        } else {
          msg
        }
        promise.reject(E_CONNECT_FAILED, detail, e)
      } finally {
        stateLock.unlock()
      }
    }
  }

  @ReactMethod
  fun disconnect(promise: Promise) {
    submit(promise) {
      stateLock.lock()
      try {
        intentionalDisconnect = true
        disconnectLocked()
        promise.resolve(null)
      } finally {
        stateLock.unlock()
      }
    }
  }

  // ---------------------------------------------------------------------------
  // exec（一次性命令）
  // ---------------------------------------------------------------------------

  @ReactMethod
  fun exec(command: String, timeoutMs: Double, promise: Promise) {
    submit(promise) {
      var channel: ChannelExec? = null
      try {
        val ch = openExecChannel(command)
        channel = ch
        val inStream = ch.inputStream
        val errStream = ch.errStream
        ch.connect(CHANNEL_OPEN_TIMEOUT_MS)

        val stdout = StringBuilder()
        val stderr = StringBuilder()
        val readerError = AtomicReference<Throwable?>()
        val latch = CountDownLatch(2)

        streamCollector(inStream, stdout, readerError, latch)
        streamCollector(errStream, stderr, readerError, latch)

        val timeout = timeoutMs.toLong().coerceAtLeast(1)
        val finished = latch.await(timeout, TimeUnit.MILLISECONDS)
        val exitCode = ch.exitStatus

        if (!finished) {
          // 超时：finally 里的 disconnect 会杀掉远端进程
          promise.reject(E_EXEC_TIMEOUT, "exec timed out after ${timeout}ms")
          return@submit
        }

        val streamErr = readerError.get()
        if (streamErr != null && exitCode < 0) {
          // 流异常且没有拿到退出码 —— 多半是 session 中途断开
          promise.reject(E_EXEC_FAILED, streamErr.message ?: "exec stream error", streamErr)
          return@submit
        }

        val result = Arguments.createMap()
        result.putString("stdout", stdout.toString())
        result.putString("stderr", stderr.toString())
        result.putInt("exitCode", exitCode)
        promise.resolve(result)
      } catch (e: Throwable) {
        promise.reject(errorCode(e, E_EXEC_FAILED), e.message ?: "exec failed", e)
      } finally {
        // channel 构造即注册进 JSch 静态池，任何路径都必须 disconnect
        try {
          channel?.disconnect()
        } catch (_: Throwable) {
          // 忽略
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // startCommand / stopCommand（长驻命令：远端 hermes serve）
  // ---------------------------------------------------------------------------

  @ReactMethod
  fun startCommand(command: String, promise: Promise) {
    submit(promise) {
      var channel: ChannelExec? = null
      try {
        val ch = openExecChannel(command)
        channel = ch
        val stdout = ch.inputStream
        val stderr = ch.errStream
        ch.connect(CHANNEL_OPEN_TIMEOUT_MS)

        val taskId = UUID.randomUUID().toString()
        tasks[taskId] = ch

        // 契约只定义 stdout 事件；stderr 必须排空，否则远端写满窗口后会阻塞。
        executor.execute { drainQuietly(stderr) }

        executor.execute {
          var exitCode = -1
          try {
            stdout.bufferedReader(Charsets.UTF_8).forEachLine { line ->
              emitEvent(EVENT_STDOUT + taskId) { putString("line", line) }
            }
            // 流 EOF 后等 channel 关闭，尽量拿到 exit-status（通常 EOF 前已收到）
            val deadline = System.currentTimeMillis() + EXIT_STATUS_GRACE_MS
            while (!ch.isClosed && System.currentTimeMillis() < deadline) {
              Thread.sleep(50)
            }
            exitCode = ch.exitStatus
          } catch (_: Throwable) {
            // session 断开 / stopCommand 等路径：exitCode 保持 -1 上报
          } finally {
            tasks.remove(taskId, ch)
            try {
              ch.disconnect()
            } catch (_: Throwable) {
              // 忽略
            }
            emitEvent(EVENT_EXIT + taskId) { putInt("exitCode", exitCode) }
          }
        }

        val result = Arguments.createMap()
        result.putString("taskId", taskId)
        promise.resolve(result)
      } catch (e: Throwable) {
        // 开通道失败：channel 构造即注册进 JSch 静态池，必须 disconnect
        channel?.let {
          try {
            it.disconnect()
          } catch (_: Throwable) {
            // 忽略
          }
        }
        promise.reject(errorCode(e, E_CHANNEL_FAILED), e.message ?: "startCommand failed", e)
      }
    }
  }

  @ReactMethod
  fun stopCommand(taskId: String, promise: Promise) {
    submit(promise) {
      // 幂等：未知 taskId 也 resolve。exit 事件由读线程 finally 统一发一次。
      val channel = tasks.remove(taskId)
      if (channel != null) {
        try {
          channel.disconnect()
        } catch (_: Throwable) {
          // 忽略
        }
      }
      promise.resolve(null)
    }
  }

  // ---------------------------------------------------------------------------
  // 本地端口转发
  // ---------------------------------------------------------------------------

  @ReactMethod
  fun openLocalForward(remotePort: Double, promise: Promise) {
    submit(promise) {
      try {
        val s = requireSession()
        val localPort = s.setPortForwardingL("127.0.0.1", 0, "127.0.0.1", remotePort.toInt())
        localForwards.add(localPort)
        val result = Arguments.createMap()
        result.putInt("localPort", localPort)
        promise.resolve(result)
      } catch (e: Throwable) {
        promise.reject(errorCode(e, E_FORWARD_FAILED), e.message ?: "openLocalForward failed", e)
      }
    }
  }

  @ReactMethod
  fun closeLocalForward(localPort: Double, promise: Promise) {
    submit(promise) {
      // 幂等：无论转发是否存在都 resolve
      val port = localPort.toInt()
      localForwards.remove(port)
      try {
        session?.takeIf { it.isConnected }?.delPortForwardingL("127.0.0.1", port)
      } catch (_: Throwable) {
        // 忽略
      }
      promise.resolve(null)
    }
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  override fun invalidate() {
    stateLock.lock()
    try {
      intentionalDisconnect = true
      disconnectLocked()
    } finally {
      stateLock.unlock()
    }
    executor.shutdownNow()
    super.invalidate()
  }

  // ---------------------------------------------------------------------------
  // 内部实现
  // ---------------------------------------------------------------------------

  private fun submit(promise: Promise, block: () -> Unit) {
    try {
      executor.execute(block)
    } catch (e: RejectedExecutionException) {
      promise.reject(E_NOT_AVAILABLE, "HermesSsh is shutting down", e)
    }
  }

  private fun requireSession(): Session {
    val s = session
    if (s == null || !s.isConnected) {
      throw JSchException("not connected")
    }
    return s
  }

  /** 打开 exec channel 并设置命令；调用方必须紧接着取流再 connect（JSch 要求）。 */
  private fun openExecChannel(command: String): ChannelExec {
    val s = requireSession()
    val channel = s.openChannel("exec") as ChannelExec
    channel.setCommand(command)
    return channel
  }

  /** 收集流到 sink，超过 MAX_STREAM_BYTES 后丢弃（继续排空防阻塞）。 */
  private fun streamCollector(
    stream: InputStream,
    sink: StringBuilder,
    readerError: AtomicReference<Throwable?>,
    latch: CountDownLatch
  ) {
    executor.execute {
      try {
        val buf = ByteArray(8192)
        while (true) {
          val n = stream.read(buf)
          if (n < 0) break
          if (sink.length < MAX_STREAM_BYTES) {
            sink.append(String(buf, 0, n, Charsets.UTF_8))
          }
        }
      } catch (e: Throwable) {
        readerError.compareAndSet(null, e)
      } finally {
        latch.countDown()
      }
    }
  }

  private fun drainQuietly(stream: InputStream) {
    try {
      val buf = ByteArray(8192)
      while (stream.read(buf) >= 0) {
        // discard
      }
    } catch (_: Throwable) {
      // 忽略
    }
  }

  /** 必须在 stateLock 下调用（或确定无并发时）。幂等。 */
  private fun disconnectLocked() {
    stopWatchdog()
    val s = session
    session = null

    for (channel in tasks.values) {
      try {
        channel.disconnect()
      } catch (_: Throwable) {
        // 忽略
      }
    }
    tasks.clear()
    localForwards.clear()

    if (s != null) {
      try {
        s.disconnect() // 连带清理该 session 的所有 PortWatcher/Channel
      } catch (_: Throwable) {
        // 忽略
      }
    }
  }

  private fun startWatchdog(s: Session) {
    stopWatchdog()
    val w = Executors.newSingleThreadScheduledExecutor { r ->
      Thread(r, "hermes-ssh-watchdog").apply { isDaemon = true }
    }
    watchdog = w
    w.scheduleWithFixedDelay({
      try {
        if (s.isConnected) return@scheduleWithFixedDelay

        var shouldEmit = false
        stateLock.lock()
        try {
          // 只有"当前会话意外断开"才上报；旧会话或主动断开跳过
          if (session === s && !intentionalDisconnect) {
            intentionalDisconnect = true
            disconnectLocked()
            shouldEmit = true
          }
        } finally {
          stateLock.unlock()
        }

        if (shouldEmit) {
          emitEvent(EVENT_DISCONNECT) {
            putString("reason", "connection lost (keepalive timeout or transport error)")
          }
        }
      } catch (_: Throwable) {
        // watchdog 永不抛出
      }
    }, WATCHDOG_INTERVAL_MS, WATCHDOG_INTERVAL_MS, TimeUnit.MILLISECONDS)
  }

  private fun stopWatchdog() {
    watchdog?.shutdownNow()
    watchdog = null
  }

  private fun emitEvent(eventName: String, params: WritableMap.() -> Unit) {
    try {
      val map = Arguments.createMap()
      map.params()
      reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(eventName, map)
    } catch (_: Throwable) {
      // ReactContext 销毁中：丢弃事件
    }
  }

  private fun errorCode(e: Throwable, fallback: String): String =
    if (e is JSchException && e.message == "not connected") E_NOT_CONNECTED else fallback

  private fun ReadableMap.getStringOrNull(key: String): String? =
    if (hasKey(key) && !isNull(key)) getString(key) else null

  private fun ReadableMap.getIntOrNull(key: String): Int? =
    if (hasKey(key) && !isNull(key)) getDouble(key).toInt() else null
}

/**
 * accept-new 语义的 UserInfo：
 * - 未知主机："The authenticity of host ..." → 自动接受（JSch 随后 add 并持久化）。
 * - 密钥变更："WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!" → 拒绝，fail closed。
 * - password / keyboard-interactive：用配置里的密码应答（私钥 passphrase 不走这里，
 *   已在 addIdentity 时提供）。
 */
/**
 * 列出 JSch 已加载身份的摘要：name[算法 SHA256指纹]，指纹 = OpenSSH 风格
 * base64nopad(sha256(publicKeyBlob))，可直接和服务端 `ssh-keygen -lf` 输出对照。
 */
private fun identitySummary(jsch: JSch): String {
  val identities = runCatching { jsch.identityRepository?.identities }.getOrNull()
    ?: return ""
  return identities.joinToString(", ") { id ->
    val blob = runCatching { id.publicKeyBlob }.getOrNull()
    val fp = blob?.let {
      val digest = MessageDigest.getInstance("SHA-256").digest(it)
      "SHA256:" + android.util.Base64.encodeToString(
        digest, android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP,
      )
    } ?: "no-pubkey"
    "${id.name}[${id.algName} $fp${if (id.isEncrypted) " encrypted" else ""}]"
  }
}

private class AcceptNewUserInfo(private val password: String?) : UserInfo, UIKeyboardInteractive {

  override fun promptYesNo(message: String): Boolean =
    !message.contains("HAS CHANGED")

  override fun getPassword(): String? = password

  override fun promptPassword(message: String): Boolean = password != null

  override fun getPassphrase(): String? = null

  override fun promptPassphrase(message: String): Boolean = false

  override fun showMessage(message: String) {
    // no-op
  }

  override fun promptKeyboardInteractive(
    destination: String,
    name: String,
    instruction: String,
    prompt: Array<String>,
    echo: BooleanArray
  ): Array<String>? {
    val pw = password ?: return null
    return Array(prompt.size) { pw }
  }
}
