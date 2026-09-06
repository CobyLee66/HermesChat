/**
 * SSH 隧道契约公共类型（docs/ssh-module.md §2）。
 * 单独成文件：web/桌面桥（desktopHermesSsh.ts）复用时不引入 react-native 依赖
 * （原生 wrapper HermesSsh.ts import 了 NativeModules，不能进 web 构建依赖图）。
 */

export interface SshConfig {
  host: string;
  port?: number; // 默认 22
  username: string;
  password?: string; // 密码认证
  privateKey?: string; // PEM 内容（优先于密码）
  passphrase?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
