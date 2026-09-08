/**
 * busyTicker — busy 指示器的客户端动画数据源。
 * 服务端 thinking.delta 每次 API 调用只发一条静态占位（{face} {verb}...），
 * 官方 dashboard 的动态效果是客户端动画（ui-tui FaceTicker）：15 颜文字 ×
 * 15 动词，每 TICK_MS 顺序轮换、随机起始。下列表与官方 content/faces.ts、
 * content/verbs.ts 保持一致。
 */

export const FACES = [
  '(｡•́︿•̀｡)',
  '(◔_◔)',
  '(¬‿¬)',
  '( •_•)>⌐■-■',
  '(⌐■_■)',
  '(´･_･`)',
  '◉_◉',
  '(°ロ°)',
  '( ˘⌣˘)♡',
  'ヽ(>∀<☆)☆',
  '٩(๑❛ᴗ❛๑)۶',
  '(⊙_⊙)',
  '(¬_¬)',
  '( ͡° ͜ʖ ͡°)',
  'ಠ_ಠ',
];

export const VERBS = [
  'pondering',
  'contemplating',
  'musing',
  'cogitating',
  'ruminating',
  'deliberating',
  'mulling',
  'reflecting',
  'processing',
  'reasoning',
  'analyzing',
  'computing',
  'synthesizing',
  'formulating',
  'brainstorming',
];

export const TICK_MS = 2500;

// VERBS 均为纯小写单词，无需转义；要求动词前是空白或行首，避免误吃
// "reconnecting..." 这类含动词词干的 provider 等待说明。
const KAWAII_RE = new RegExp(`(?:^|\\s)(?:${VERBS.join('|')})\\.\\.\\.$`);

/** thinking.delta 占位文本是否为 kawaii 帧（{face} {verb}... 结尾）。 */
export function isKawaiiHint(text: string): boolean {
  return KAWAII_RE.test(text);
}

/** 第 faceIdx/verbIdx 帧的显示文本（越界取模）。 */
export function tickerText(faceIdx: number, verbIdx: number): string {
  const face = FACES[faceIdx % FACES.length];
  const verb = VERBS[verbIdx % VERBS.length];
  return `${face} ${verb}...`;
}
