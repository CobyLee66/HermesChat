/**
 * 斜杠命令的补全与执行（对齐 hermes dashboard 三端共用的客户端契约，
 * 移植自官方预留给第三方客户端的 web/src/lib/slashExec.ts + SlashPopover）。
 *
 * 服务端职责：`complete.slash` 负责模糊匹配/排序/参数阶段提示（ replace_from
 * 指明替换起点）；`slash.exec` 为命令主执行通道，失败时回退 `command.dispatch`
 * 拿类型化指令（skill/send 型再转 prompt.submit）。prompt.submit 本身不拦截
 * 斜杠文本，客户端必须在发送前分流，否则命令会被当普通文本发给模型。
 */

import {t} from '../i18n';

/** complete.slash 返回的单个补全项（registry 项 text 不带 /，TUI extras 带 /）。 */
export interface SlashCompletionItem {
  text: string;
  display: string;
  meta?: string;
  kind?: 'command' | 'skill';
}

export interface SlashCompletionResult {
  items: SlashCompletionItem[];
  /** 输入框中补全的替换起点（名称阶段=1 保留 "/"；参数阶段=最后一个空格后）。 */
  replaceFrom: number;
}

/** command.dispatch 的类型化指令。 */
export type CommandDispatchResponse =
  | {type: 'exec' | 'plugin'; output?: string}
  | {type: 'alias'; target: string}
  | {type: 'skill'; name: string; message?: string}
  | {type: 'send'; message: string};

export type SlashExecResult = 'done' | 'sent' | 'error';

export interface SlashExecCallbacks {
  /** 往时间线追加系统行（命令回显/输出/警告）。 */
  sys(text: string): void;
  /** 把消息作为普通 prompt 提交（skill/send 型指令的落点）。 */
  send(message: string): Promise<void> | void;
}

export interface SlashExecOptions {
  /** 原始命令，含前导斜杠（如 "/model gpt-x"）。 */
  command: string;
  sessionId: string;
  /** RPC 调用注入（生产传 getRpc().call，测试传 fake）。 */
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  callbacks: SlashExecCallbacks;
}

/**
 * 行首斜杠命令判定（TUI domain/slash.ts 同款正则）：^ 锚定命令语义，
 * 「/ 后不允许再出现 /」排除 /usr/local 之类路径；句中斜杠不触发。
 */
export function looksLikeSlashCommand(text: string): boolean {
  return /^\/[^\s/]*(?:\s|$)/.test(text);
}

/** /model 交由 App 内模型面板两步选择（TUI 同款特判），不进补全列表。 */
export function isModelCommandInput(text: string): boolean {
  return /^\/model(?:\s|$)/.test(text);
}

/** 归一化 complete.slash 响应：字段缺失时兜底为空补全。 */
export function normalizeCompletionResponse(raw: unknown): SlashCompletionResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const items = Array.isArray(r.items)
    ? r.items
        .map(it => {
          const o = (it ?? {}) as Record<string, unknown>;
          return {
            text: typeof o.text === 'string' ? o.text : '',
            display:
              typeof o.display === 'string' && o.display ? o.display : (typeof o.text === 'string' ? o.text : ''),
            meta: typeof o.meta === 'string' ? o.meta : undefined,
            kind: o.kind === 'skill' ? ('skill' as const) : ('command' as const),
          };
        })
        .filter(it => it.text.length > 0)
    : [];
  return {
    items,
    replaceFrom: typeof r.replace_from === 'number' ? r.replace_from : 1,
  };
}

/** 应用补全：保留 replaceFrom 之前的前缀，拼上补全项文本。 */
export function applyCompletion(
  input: string,
  replaceFrom: number,
  itemText: string,
): string {
  const from = Math.max(0, Math.min(replaceFrom, input.length));
  // TUI domain/slash.ts 同款：registry 项 text 不带斜杠而 TUI extras 带
  // （如 /density），替换点前一位已是 "/" 时去掉项首斜杠防 "//" 重复。
  const text =
    input[from - 1] === '/' && itemText.startsWith('/')
      ? itemText.slice(1)
      : itemText;
  return input.slice(0, from) + text;
}

/** 拆出命令名与参数（web slashExec 同款）。 */
export function parseSlash(command: string): {name: string; arg: string} {
  const m = command.replace(/^\/+/, '').match(/^(\S+)\s*(.*)$/);
  return m ? {name: m[1], arg: m[2].trim()} : {name: '', arg: ''};
}

function parseCommandDispatch(raw: unknown): CommandDispatchResponse | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  switch (r.type) {
    case 'exec':
    case 'plugin':
      return {type: r.type, output: str(r.output)};
    case 'alias':
      return typeof r.target === 'string' ? {type: 'alias', target: r.target} : null;
    case 'skill':
      return typeof r.name === 'string'
        ? {type: 'skill', name: r.name, message: str(r.message)}
        : null;
    case 'send':
      return typeof r.message === 'string' ? {type: 'send', message: r.message} : null;
    default:
      return null;
  }
}

/**
 * 执行一条斜杠命令（web slashExec.ts 同款流水线）：
 * 1. slash.exec —— registry 命令主通道，输出进系统行；
 * 2. 失败回退 command.dispatch —— 按返回的指令类型分派：
 *    exec/plugin 直接输出；alias 递归执行目标；skill/send 转 prompt 提交。
 * 返回终态供调用方决定是否需要额外处理（当前仅用于测试与日志）。
 */
export async function executeSlash({
  command,
  sessionId,
  call,
  callbacks: {sys, send},
}: SlashExecOptions): Promise<SlashExecResult> {
  const {name, arg} = parseSlash(command);

  if (!name) {
    sys(t('slash.empty'));
    return 'error';
  }

  try {
    const r = (await call('slash.exec', {
      command: command.replace(/^\/+/, ''),
      session_id: sessionId,
    })) as {output?: string; warning?: string} | null;
    const body = r?.output || t('slash.noOutput', {name});
    sys(r?.warning ? t('slash.warning', {warning: r.warning, body}) : body);
    return 'done';
  } catch {
    // 主通道拒绝/未知命令/需要客户端行为 → 落到 dispatch
  }

  try {
    const d = parseCommandDispatch(
      await call('command.dispatch', {name, arg, session_id: sessionId}),
    );
    if (!d) {
      sys(t('slash.invalidDispatch'));
      return 'error';
    }
    switch (d.type) {
      case 'exec':
      case 'plugin':
        sys(d.output ?? t('slash.noneOutput'));
        return 'done';
      case 'alias':
        return executeSlash({
          command: `/${d.target}${arg ? ` ${arg}` : ''}`,
          sessionId,
          call,
          callbacks: {sys, send},
        });
      case 'skill':
      case 'send': {
        const msg = d.message?.trim() ?? '';
        if (!msg) {
          sys(
            `/${name}: ${
              d.type === 'skill'
                ? t('slash.skillMissingMessage')
                : t('slash.dispatchEmpty')
            }`,
          );
          return 'error';
        }
        if (d.type === 'skill') {
          sys(t('slash.skillLoaded', {name: d.name}));
        }
        await send(msg);
        return 'sent';
      }
    }
  } catch (e) {
    sys(t('slash.error', {
      message: e instanceof Error ? e.message : String(e),
    }));
    return 'error';
  }
}
