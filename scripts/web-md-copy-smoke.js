/**
 * web-md-copy-smoke.js — 桌面端 markdown 复制双入口实测（Playwright，只读）。
 *
 * 前置：`npx vite --port 5188` 已运行，本机 hermes 9119 可达。
 * 验证（全程只读：进已有会话看历史，不发送消息）：
 *  1. markdown 渲染块带 data-md-map 源行号；
 *  2. 拖选（Selection+Cmd+C）标题块 → 剪贴板得到以 # 开头的源码；
 *  3. 全选气泡复制 与 右键「复制 Markdown」结果一致（整条源码）；
 *  4. 右键「复制纯文本」得到渲染后文本（无 # 前缀）；
 *  5. 输入框内复制不受拦截影响。
 */

const {chromium} = require('playwright-core');

const EXE =
  '~/Library/Caches/ms-playwright/chromium_headless_shell-1234/' +
  'chrome-headless-shell-mac-arm64/chrome-headless-shell';
const BASE = 'http://localhost:5188/';
const OUT = 'docs/screenshots';

async function main() {
  const browser = await chromium.launch({executablePath: EXE, headless: true});
  const context = await browser.newContext({
    viewport: {width: 900, height: 900},
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));

  // 连接（无配置则添加直连配置）→ 进第一个 profile → 进第一个会话
  await page.goto(BASE, {waitUntil: 'domcontentloaded'});
  await page.waitForTimeout(1500);
  const addBtn = page.getByText('＋ 添加配置');
  if ((await addBtn.count()) > 0) {
    await addBtn.click();
    await page.getByText('连接类型').waitFor({timeout: 5000});
    await page.getByText('直连', {exact: true}).click();
    await page.getByPlaceholder('例如：本机 gateway').fill('本机直连-复制测试');
    await page.getByText('保存', {exact: true}).click();
    await page.getByText('本机直连-复制测试').waitFor({timeout: 5000});
  }
  await page.getByText('本机直连-复制测试').click();
  await page.waitForSelector('[aria-label^="打开 profile"]', {timeout: 20000});
  await page.waitForTimeout(1500);
  await page.locator('[aria-label^="打开 profile"]').first().click();
  await page.waitForTimeout(2500);

  // 第一个会话行 = 会话列中含头像 img 的第一个 tabindex 容器
  const firstRow = page.locator('[tabindex]').filter({has: page.locator('img')}).first();
  await firstRow.click();
  await page.waitForSelector('.hm-md [data-md-map]', {timeout: 20000});
  await page.waitForTimeout(1000); // 等历史块全部渲染
  const blockCount = await page.locator('.hm-md [data-md-map]').count();
  console.log('>> 历史已加载，带源行号的块数:', blockCount);
  await page.screenshot({path: `${OUT}/web-mdcopy-1-chat.png`});

  const readClip = () => page.evaluate(() => navigator.clipboard.readText());
  const selectNode = selector =>
    page.evaluate(sel => {
      const el = document.querySelector(sel);
      if (!el) {
        return false;
      }
      const range = document.createRange();
      range.selectNodeContents(el);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);
      return true;
    }, selector);

  // ---- 1. 标题块：选中 → Cmd+C → 应得以 # 开头的源码 ----
  const headingSel = await page.evaluate(() => {
    const tags = ['h1', 'h2', 'h3'];
    for (const t of tags) {
      const el = document.querySelector(`.hm-md ${t}[data-md-map]`);
      if (el) {
        return `.hm-md ${t}[data-md-map="${el.getAttribute('data-md-map')}"]`;
      }
    }
    return null;
  });
  if (headingSel) {
    await selectNode(headingSel);
    await page.keyboard.press('ControlOrMeta+c');
    const copied = await readClip();
    console.log('>> 标题块复制结果:', JSON.stringify(copied.slice(0, 60)));
    if (!/^#{1,6} /.test(copied)) {
      throw new Error(`标题块复制未得到 # 源码: ${JSON.stringify(copied.slice(0, 80))}`);
    }
    console.log('PASS 1: 拖选标题块 → Cmd+C 得到以 # 开头的 Markdown 源码');
  } else {
    console.log('SKIP 1: 该会话历史无标题块（改用下方全选断言覆盖）');
  }

  // ---- 2. 全选某气泡 vs 右键「复制 Markdown」，两者应一致（整条源码） ----
  // 目标气泡取视口内块最多的（mouse 右键依赖视口坐标，DOM 全选不受限但
  // 两个入口必须对比同一条消息）
  const targetIdx = await page.evaluate(() => {
    let best = -1;
    let bestN = -1;
    document.querySelectorAll('.hm-md').forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (r.y < 0 || r.y + r.height > window.innerHeight) {
        return;
      }
      const n = el.querySelectorAll('[data-md-map]').length;
      if (n > bestN) {
        bestN = n;
        best = i;
      }
    });
    return best >= 0 ? best : 0;
  });
  const richestBubble = targetIdx;
  await page.evaluate(
    idx => {
      const els = document.querySelectorAll('.hm-md');
      const el = els[idx];
      const range = document.createRange();
      range.selectNodeContents(el);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);
    },
    richestBubble,
  );
  await page.keyboard.press('ControlOrMeta+c');
  const wholeSelect = await readClip();
  console.log(
    '>> 全选气泡复制（前 80 字）:',
    JSON.stringify(wholeSelect.slice(0, 80)),
  );

  // 右键「复制 Markdown」（先清掉全选残留的选区；同一气泡）
  await page.screenshot({path: `${OUT}/web-mdcopy-2-selected.png`});
  await page.evaluate(() => window.getSelection().removeAllRanges());
  const bubbleBox = await page
    .locator('.hm-md')
    .nth(richestBubble)
    .boundingBox();
  console.log('>> 右键目标气泡 index=', richestBubble, 'box=', JSON.stringify(bubbleBox));
  await page.mouse.click(bubbleBox.x + 30, bubbleBox.y + 10, {button: 'right'});
  await page.getByText('复制 Markdown', {exact: true}).waitFor({timeout: 5000});
  await page.screenshot({path: `${OUT}/web-mdcopy-3-context-menu.png`});
  await page.getByText('复制 Markdown', {exact: true}).click();
  await page.waitForTimeout(300);
  const wholeMenu = await readClip();

  if (!wholeMenu.trim()) {
    throw new Error('右键「复制 Markdown」剪贴板为空');
  }
  if (wholeSelect.trim() !== wholeMenu.trim()) {
    throw new Error(
      `全选拖选(${wholeSelect.trim().length}字) ≠ 右键复制(${wholeMenu.trim().length}字)`,
    );
  }
  console.log('PASS 2: 全选拖选复制 ≡ 右键「复制 Markdown」（整条源码'
    + `，${wholeMenu.trim().length} 字）`);

  // ---- 3. 右键「复制纯文本」→ 渲染后文本（无 # 行首） ----
  await page.mouse.click(bubbleBox.x + 30, bubbleBox.y + 10, {button: 'right'});
  await page.getByText('复制纯文本', {exact: true}).waitFor({timeout: 5000});
  await page.getByText('复制纯文本', {exact: true}).click();
  await page.waitForTimeout(300);
  const plain = await readClip();
  if (!plain.trim()) {
    throw new Error('「复制纯文本」剪贴板为空');
  }
  const plainHasHeadingSyntax = /^#{1,6} /m.test(plain);
  const menuHasHeadingSyntax = /^#{1,6} /m.test(wholeMenu);
  if (menuHasHeadingSyntax && plainHasHeadingSyntax) {
    throw new Error('「复制纯文本」仍含 # 标题语法，未取渲染后文本');
  }
  console.log('PASS 3: 右键「复制纯文本」得到渲染后文本（无 # 语法）');

  // ---- 4. 输入框内复制不受拦截影响 ----
  const input = page.locator('textarea, input[type="text"]').last();
  await input.click();
  await input.fill('复制测试xyz');
  await page.evaluate(() => {
    const els = document.querySelectorAll('textarea, input');
    const el = els[els.length - 1];
    if (el && typeof el.select === 'function') {
      el.select();
    }
  });
  await page.keyboard.press('ControlOrMeta+c');
  const inputCopied = await readClip();
  if (inputCopied !== '复制测试xyz') {
    throw new Error(`输入框复制被拦截或异常: ${JSON.stringify(inputCopied)}`);
  }
  await input.fill('');
  console.log('PASS 4: 输入框内复制不受气泡拦截影响');

  console.log('OK web 端 markdown 复制双入口全部通过');
  await browser.close();
}

main().catch(e => {
  console.error('[FAIL]', e.message);
  process.exit(1);
});
