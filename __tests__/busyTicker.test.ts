import {
  FACES,
  isKawaiiHint,
  TICK_MS,
  tickerText,
  VERBS,
} from '../src/utils/busyTicker';

describe('busyTicker busy 指示器客户端动画', () => {
  it('isKawaiiHint：{face} {verb}... 结尾的占位帧判为 kawaii', () => {
    expect(isKawaiiHint('(´･_･) computing...')).toBe(true);
    expect(isKawaiiHint('◉_◉ cogitating...')).toBe(true);
  });

  it('isKawaiiHint：⏳/⚠ provider 等待说明不是 kawaii 帧', () => {
    expect(
      isKawaiiHint('⏳ waiting on local-model — 30s with no output yet'),
    ).toBe(false);
    expect(
      isKawaiiHint('⚠ no output from provider for 900s — reconnecting...'),
    ).toBe(false);
  });

  it('isKawaiiHint：动词必须在词首（防误吃词干后缀）', () => {
    // "uncomputing..." 含 computing 但前面不是空白/行首
    expect(isKawaiiHint('x uncomputing...')).toBe(false);
    // 裸动词帧（无颜文字）也算 kawaii
    expect(isKawaiiHint('processing...')).toBe(true);
  });

  it('tickerText 组合 {face} {verb}...，越界下标取模', () => {
    expect(tickerText(0, 0)).toBe(`${FACES[0]} ${VERBS[0]}...`);
    expect(tickerText(FACES.length, VERBS.length)).toBe(
      `${FACES[0]} ${VERBS[0]}...`,
    );
  });

  it('与官方列表一致：15 颜文字 × 15 动词，2.5s 轮换', () => {
    expect(FACES).toHaveLength(15);
    expect(VERBS).toHaveLength(15);
    expect(TICK_MS).toBe(2500);
  });
});
