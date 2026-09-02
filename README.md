This is a new [**React Native**](https://reactnative.dev) project, bootstrapped using [`@react-native-community/cli`](https://github.com/react-native-community/cli).

# Getting Started

> **Note**: Make sure you have completed the [Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment) guide before proceeding.

## Step 1: Start Metro

First, you will need to run **Metro**, the JavaScript build tool for React Native.

To start the Metro dev server, run the following command from the root of your React Native project:

```sh
# Using npm
npm start

# OR using Yarn
yarn start
```

## Step 2: Build and run your app

With Metro running, open a new terminal window/pane from the root of your React Native project, and use one of the following commands to build and run your Android or iOS app:

### Android

```sh
# Using npm
npm run android

# OR using Yarn
yarn android
```

### iOS

For iOS, remember to install CocoaPods dependencies (this only needs to be run on first clone or after updating native deps).

The first time you create a new project, run the Ruby bundler to install CocoaPods itself:

```sh
bundle install
```

Then, and every time you update your native dependencies, run:

```sh
bundle exec pod install
```

For more information, please visit [CocoaPods Getting Started guide](https://guides.cocoapods.org/using/getting-started.html).

```sh
# Using npm
npm run ios

# OR using Yarn
yarn ios
```

If everything is set up correctly, you should see your new app running in the Android Emulator, iOS Simulator, or your connected device.

This is one way to run your app — you can also build it directly from Android Studio or Xcode.

## Step 3: Modify your app

Now that you have successfully run the app, let's make changes!

Open `App.tsx` in your text editor of choice and make some changes. When you save, your app will automatically update and reflect these changes — this is powered by [Fast Refresh](https://reactnative.dev/docs/fast-refresh).

When you want to forcefully reload, for example to reset the state of your app, you can perform a full reload:

- **Android**: Press the <kbd>R</kbd> key twice or select **"Reload"** from the **Dev Menu**, accessed via <kbd>Ctrl</kbd> + <kbd>M</kbd> (Windows/Linux) or <kbd>Cmd ⌘</kbd> + <kbd>M</kbd> (macOS).
- **iOS**: Press <kbd>R</kbd> in iOS Simulator.

## Congratulations! :tada:

You've successfully run and modified your React Native App. :partying_face:

### Now what?

- If you want to add this new React Native code to an existing application, check out the [Integration guide](https://reactnative.dev/docs/integration-with-existing-apps).
- If you're curious to learn more about React Native, check out the [docs](https://reactnative.dev/docs/getting-started).

# Troubleshooting

If you're having issues getting the above steps to work, see the [Troubleshooting](https://reactnative.dev/docs/troubleshooting) page.

# Learn More

To learn more about React Native, take a look at the following resources:

- [React Native Website](https://reactnative.dev) - learn more about React Native.
- [Getting Started](https://reactnative.dev/docs/environment-setup) - an **overview** of React Native and how setup your environment.
- [Learn the Basics](https://reactnative.dev/docs/getting-started) - a **guided tour** of the React Native **basics**.
- [Blog](https://reactnative.dev/blog) - read the latest official React Native **Blog** posts.
- [`@facebook/react-native`](https://github.com/facebook/react-native) - the Open Source; GitHub **repository** for React Native.

---

# HermesMobile（项目说明）

Hermes Agent 的手机端远程操控 App（Android 优先）。设计见 `docs/plan.md`，协议速查见 `docs/protocol.md`，SSH 原生模块契约见 `docs/ssh-module.md`。

## 本地（Mac）验证

本机无原生构建工具链，JS 层用以下方式验证：

```bash
npx tsc --noEmit        # 类型检查
npm run lint            # lint
npm test                # jest 单测（aggregator / connection 状态机）
node scripts/harness.mjs  # 端到端打本机 127.0.0.1:9119 的 live dashboard（限一次真实 prompt）
```

### 浏览器本地调试（react-native-web，免 APK）

```bash
npm run web   # vite dev server，默认 http://localhost:5188
```

浏览器打开后点连接主页的「⚡ 浏览器直连（本机 127.0.0.1:9119）」即可连上本机
live dashboard（vite 把 `/api/**` 与 `/__hermes/**` 代理到 9119 并重写
Host/Origin，绕过 dashboard 的 WS Host/Origin 防护；token 从 SPA HTML 提取）。
可直接进 profile → 会话列表 → 会话，看聊天气泡/工具卡片等 UI。

注意：

- web 构建把 `react-native` 别名到 `react-native-web`，原生模块
  （HermesSsh / RNFS / documents-picker / audio-recorder-player /
  async-storage / image-resizer）打桩在 `src/web-stubs/`
  （async-storage 用 localStorage 实现，其余方法 reject）。
- SSH 隧道配置在浏览器里不可用（直连入口是 web 唯一连接方式）；
  附件上传/语音输入/头像上传等依赖原生模块的功能在浏览器里不可用（按钮点击会报打桩错误）。
- `vite.config.ts` 已排除在 tsconfig 之外（vite 的类型依赖会把 DOM/node 全局
  类型引入程序，与 RN 的 WebSocket 等声明冲突）。


## 构建机 构建与安装（Android）

构建机（Windows，`~/.ssh/config` 别名 `构建机`）已配好全部工具链：Node 26 / JDK 21 / Android SDK（platforms android-36 + android-37.0、build-tools 37.0.0、ndk 27.1.12297006）、Maven 阿里云镜像（`C:\Users\Public\.gradle\init.d\mirror.gradle`，直连 Maven Central 会被断）。

代码同步走 GitHub（私有仓库 `CobyLee66/HermesMobile`）：Mac 推送，构建机 拉取。Mac 上一键操作：

```bash
git add -A && git commit -m "..."        # 先提交改动
scripts/build-android.sh [release|debug]   # 推送 -> 构建机 git pull -> 构建 -> APK 取回 dist/
scripts/install-android.sh [apk] [序列号]   # 经 构建机 adb 安装到手机（USB 或无线调试）
```

在 构建机 上手动：`cd C:\HermesMobile && git pull && cd android && gradlew.bat assembleRelease`。

构建报错先修 `android/app/src/main/java/com/hermesmobile/ssh/`（`docs/ssh-module.md` §6 存疑点已于首次构建验证通过）。

## 运行模式

- **开发直连**：App 设置页开"开发直连"，填 `127.0.0.1:9119`（手机与电脑同网时填电脑局域网 IP + dashboard 需绑非 loopback 并认证；模拟器可直接 10.0.2.2）。
- **SSH 隧道（正式）**：填远端主机/端口/用户名/密码或私钥，App 自动探测/拉起远端 `hermes serve`、建本地转发、断线自动重连并 `session.resume`。
