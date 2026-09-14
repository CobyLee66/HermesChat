module.exports = {
  preset: '@react-native/jest-preset',
  // i18n：测试统一钉 zh-CN（jest 无原生 locale 检测，初始解析会落到 en）
  setupFilesAfterEnv: ['./jest/setup.ts'],
};
