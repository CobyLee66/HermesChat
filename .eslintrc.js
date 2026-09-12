module.exports = {
  root: true,
  extends: '@react-native',
  // eslint 不读 .gitignore，构建产物必须在这里显式排除，否则 lint 会把
  // dist-web/ 等打包结果也扫一遍（曾导致 368 errors 的假基线）
  ignorePatterns: [
    'scripts/', // 构建/安装/冒烟脚本，非 App 代码
    'android/', // Kotlin，由 Android 工具链负责
    'ios/', // Swift/ObjC，由 Xcode 工具链负责
    'coverage/',
    'dist/', // 打包产物
    'dist-web/', // vite 产物（Electron 静态资源）
    'dist-desktop/', // electron-builder 产物
    'desktop/dist/', // Electron 主进程编译产物
    'web/dist/',
  ],
};
