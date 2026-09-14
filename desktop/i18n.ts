/**
 * i18n — desktop 主进程独立翻译域（极简实现）。
 *
 * 为什么不复用 src/i18n：主进程 tsconfig 隔离编译（rootDir 限定 desktop/，
 * 见 desktop/tsconfig.json），引入 src/ 会破坏 rootDir 与产物布局；且主进程
 * 用户可见文案仅个位数（代理错误响应、HostKey 校验等，经渲染层弹窗展示），
 * 内置双语言词典即可。appendLog 诊断日志不属于用户文案，保持中文不翻译。
 *
 * 语言解析：app.getLocale()，zh* → zh-CN，其余回退 en（与 src/i18n/resolveLocale
 * 同规则）。新增主进程用户可见文案时在 MESSAGES 登记两语言。
 */

import {app} from 'electron';

type Lang = 'zh-CN' | 'en';

let cachedLang: Lang | null = null;

function lang(): Lang {
  if (cachedLang === null) {
    const raw = app.getLocale?.() ?? '';
    cachedLang = raw.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
  }
  return cachedLang;
}

function fmt(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

const MESSAGES: Record<string, Record<Lang, string>> = {
  'ssh.hostKeyChanged': {
    'zh-CN': 'HostKey 已变更（远端 {key} 指纹 {fp}，本地记录 {stored}）',
    en: 'Host key has changed (remote {key} fingerprint {fp}, locally recorded {stored})',
  },
  'ssh.notConnected': {'zh-CN': 'SSH 未连接', en: 'SSH not connected'},
  'ssh.execTimeout': {
    'zh-CN': 'exec 超时（{ms}ms）：{cmd}',
    en: 'exec timed out after {ms}ms: {cmd}',
  },
  'ssh.outputTruncated': {
    'zh-CN': '（输出超过 8MiB 已截断）',
    en: ' (output exceeded 8MiB and was truncated)',
  },
  'static.notFound': {
    'zh-CN': 'Not Found（dist-web 未构建？先运行 npm run web:build）',
    en: 'Not Found (dist-web not built? run npm run web:build first)',
  },
  'proxy.notReady': {
    'zh-CN': '连接未建立（SSH 隧道未建立或直连未配置）',
    en: 'Connection not established (SSH tunnel not up or direct connect not configured)',
  },
  'proxy.upstreamFailed': {
    'zh-CN': '上游连接失败',
    en: 'Upstream connection failed',
  },
  'proxy.portsExhausted': {
    'zh-CN': '回环代理端口 {from}~{to} 全部被占用',
    en: 'Loopback proxy ports {from}~{to} are all in use',
  },
  'direct.addrInvalid': {
    'zh-CN': '直连地址无效（host:port）',
    en: 'Invalid direct address (host:port)',
  },
  'direct.tokenExtractFail': {
    'zh-CN': '未能从 gateway 首页提取 session token，可在配置中手动填写',
    en: 'Could not extract the session token from the gateway home page. Fill it in manually in the connection settings.',
  },
  'direct.gatewayTimeout': {
    'zh-CN': '连接 gateway 超时（{ms}ms）',
    en: 'Gateway connection timed out after {ms}ms',
  },
  'dialog.images': {'zh-CN': '图片', en: 'Images'},
  'desktop.readFileFailedMsg': {
    'zh-CN': '读取文件失败：{message}',
    en: 'Failed to read file: {message}',
  },
  // macOS 应用菜单
  'menu.about': {'zh-CN': '关于 HermesChat', en: 'About HermesChat'},
  'menu.hide': {'zh-CN': '隐藏 HermesChat', en: 'Hide HermesChat'},
  'menu.hideOthers': {'zh-CN': '隐藏其他', en: 'Hide Others'},
  'menu.unhide': {'zh-CN': '全部显示', en: 'Show All'},
  'menu.quit': {'zh-CN': '退出 HermesChat', en: 'Quit HermesChat'},
  'menu.edit': {'zh-CN': '编辑', en: 'Edit'},
  'menu.undo': {'zh-CN': '撤销', en: 'Undo'},
  'menu.redo': {'zh-CN': '重做', en: 'Redo'},
  'menu.cut': {'zh-CN': '剪切', en: 'Cut'},
  'menu.copy': {'zh-CN': '拷贝', en: 'Copy'},
  'menu.paste': {'zh-CN': '粘贴', en: 'Paste'},
  'menu.selectAll': {'zh-CN': '全选', en: 'Select All'},
  'menu.view': {'zh-CN': '视图', en: 'View'},
  'menu.reload': {'zh-CN': '重新加载', en: 'Reload'},
  'menu.forceReload': {'zh-CN': '强制重新加载', en: 'Force Reload'},
  'menu.devTools': {'zh-CN': '开发者工具', en: 'Toggle Developer Tools'},
  'menu.window': {'zh-CN': '窗口', en: 'Window'},
  'menu.minimize': {'zh-CN': '最小化', en: 'Minimize'},
  'menu.zoom': {'zh-CN': '缩放', en: 'Zoom'},
  'menu.close': {'zh-CN': '关闭窗口', en: 'Close Window'},
};

type Key = keyof typeof MESSAGES;

/** 主进程用户可见文案取词（t 的 desktop 域版本）。 */
export function dt(key: Key, params?: Record<string, string | number>): string {
  const dict = MESSAGES[key];
  const template = dict[lang()] ?? dict.en;
  return params ? fmt(template, params) : template;
}
