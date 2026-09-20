/**
 * web-md-copy-smoke.js — 桌面端 markdown 复制三入口实测（Playwright + mock gateway）。
 *
 * 全程不打真实 gateway：自起 mock-gateway（mdHistory 种子：标题+段落+表格+列表
 * 的确定性块结构）+ 自起 vite build/preview（HERMES_VITE_UPSTREAM 指向 mock，
 * 用 build+preview 而非 dev——dev 首开聊天会重新预构建触发整页 reload）。
 * 验证（只读：进 mock 会话看历史，不发送消息）：
 *  1. markdown 渲染块带 data-md-map 源行号；
 *  2. 拖选（Selection+Cmd+C）整个标题块 → 剪贴板得到以 ## 开头的源码；
 *     块内部分拖选 → 剪贴板 = 所选渲染文本本身（D055 修订 D030）；
 *     保持选区右键 →「复制选中内容」→ 所选文本；
 *  3. 全选气泡复制 与 右键「复制 Markdown」结果一致（整条源码）；
 *  4. 右键「复制纯文本」得到渲染后文本（无 # 前缀）；
 *  5. 输入框内复制不受拦截影响。
 *
 * 用法：node scripts/web-md-copy-smoke.js
 * 端口冲突换道：SMOKE_MOCK_PORT / SMOKE_VITE_PORT 环境变量。
 */

const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright-core');

const {startMockGateway} = require('./mock-gateway');

const ROOT = path.join(__dirname, '..');
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 9197);
const VITE_PORT = Number(process.env.SMOKE_VITE_PORT || 5187);
const SESSION_TITLE = '复制冒烟';
const HEADING_TEXT = '发布清单与本周收尾工作安排';
const OUT = 'docs/screenshots';

// Chromium 路径由 playwright-core 按自身版本解析（默认 ~/Library/Caches/ms-playwright，
// 可用 PLAYWRIGHT_BROWSERS_PATH 覆盖），升级依赖后重跑下方安装命令即可，勿硬编码版本目录。
const EXE = chromium.executablePath();
if (!fs.existsSync(EXE)) {
  console.error(`未找到 Chromium：${EXE}`);
  console.error('请先安装：npx playwright-core install chromium');
  process.exit(1);
}

let gw;

async function main() {
  gw = await startMockGateway({port: MOCK_PORT, title: SESSION_TITLE, mdHistory: true});
  console.log(`>> mock gateway: http://127.0.0.1:${MOCK_PORT}（mdHistory 种子）`);

  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const viteEnv = {
    ...process.env,
    HERMES_VITE_UPSTREAM: `http://127.0.0.1:${MOCK_PORT}`,
  };
  await new Promise((resolve, reject) => {
    const build = spawn(process.execPath, [viteBin, 'build'], {
      cwd: ROOT,
      env: viteEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    build.stderr.on('data', d => (err += String(d)));
    build.on('exit', code =>
      code === 0 ? resolve() : reject(new Error(`vite build 失败:\n${err.slice(-800)}`)),
    );
  });
  const vite = spawn(
    process.execPath,
    [viteBin, 'preview', '--port', String(VITE_PORT), '--strictPort'],
    {cwd: ROOT, env: viteEnv, stdio: ['ignore', 'pipe', 'pipe']},
  );
  const viteUrl = `http://localhost:${VITE_PORT}/`;

  const browser = await chromium.launch({executablePath: EXE, headless: true});
  let page;
  try {
    // 等 preview 就绪
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(viteUrl);
        if (r.ok) {
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    console.log(`>> vite 就绪: ${viteUrl}（上游 → mock ${MOCK_PORT}）`);

    const context = await browser.newContext({
      viewport: {width: 900, height: 900},
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    page = await context.newPage();
    page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));

    // 连接（无配置则添加直连配置）→ 进第一个 profile → 进种子会话
    await page.goto(viteUrl, {waitUntil: 'domcontentloaded'});
    await page.waitForTimeout(1500);
    await page.evaluate(() => localStorage.clear());
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForTimeout(1200);
    await page.getByText('＋ 添加配置').click();
    await page.getByText('连接类型').waitFor({timeout: 5000});
    await page.getByText('直连', {exact: true}).click();
    await page.getByPlaceholder('例如：本机 gateway').fill('复制冒烟-直连');
    await page.getByText('保存', {exact: true}).click();
    await page.getByText('复制冒烟-直连').waitFor({timeout: 5000});
    await page.getByText('复制冒烟-直连').click();
    await page.waitForSelector('[aria-label^="打开 profile"]', {timeout: 20000});
    await page.waitForTimeout(1000);
    await page.locator('[aria-label^="打开 profile"]').first().click();
    await page.getByText(SESSION_TITLE, {exact: true}).waitFor({timeout: 10000});
    await page.getByText(SESSION_TITLE, {exact: true}).click();
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

    // ---- 1. 标题块整选 → Cmd+C → 应得以 ## 开头的源码 ----
    const headingSel = await page.evaluate(() => {
      const el = document.querySelector('.hm-md h2[data-md-map]');
      return el
        ? `.hm-md h2[data-md-map="${el.getAttribute('data-md-map')}"]`
        : null;
    });
    if (!headingSel) {
      throw new Error('mock 种子会话应有 h2 标题块（mdHistory 未生效？）');
    }
    await selectNode(headingSel);
    await page.keyboard.press('ControlOrMeta+c');
    const copied = await readClip();
    console.log('>> 标题块复制结果:', JSON.stringify(copied.slice(0, 60)));
    if (!/^## /.test(copied)) {
      throw new Error(`标题块整选复制未得到 ## 源码: ${JSON.stringify(copied.slice(0, 80))}`);
    }
    console.log('PASS 1: 整选标题块 → Cmd+C 得到以 ## 开头的 Markdown 源码');

    // ---- 1b. 真实鼠标拖选标题块部分文字 → Cmd+C → 所选文本本身 ----
    // （程序化 Selection 会绕过 RNW Touchable 对拖选的阻止，必须补真实
    //  鼠标路径：Bubble web 分支不包 TouchableOpacity 才能拖中文字）
    const vh = await page.evaluate(() => {
      const el = document.querySelector('.hm-md h2[data-md-map]');
      if (!el) {
        return null;
      }
      el.scrollIntoView({block: 'center'});
      const r = el.getBoundingClientRect();
      return {x: r.x, y: r.y, w: r.width, h: r.height};
    });
    console.log('>> 真实拖选目标 heading:', JSON.stringify(vh));
    // 先清掉 PASS 1 的程序化残留选区：mousedown 落在已有选区内拖动会触发
    // 文本拖拽（drag）而非开始新选择
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.mouse.move(vh.x + 10, vh.y + vh.h / 2);
    await page.mouse.down();
    await page.mouse.move(vh.x + Math.min(60, vh.w - 5), vh.y + vh.h / 2, {
      steps: 6,
    });
    await page.mouse.up();
    const dragSel = await page.evaluate(() => String(window.getSelection()));
    if (dragSel.length === 0) {
      throw new Error('真实鼠标拖选未产生选区（RNW Touchable 阻止拖选回归？）');
    }
    if (dragSel.length >= HEADING_TEXT.length) {
      throw new Error(`拖选应只覆盖标题一部分，实际选中 ${dragSel.length} 字`);
    }
    await page.keyboard.press('ControlOrMeta+c');
    const dragCopied = await readClip();
    if (dragCopied !== dragSel) {
      throw new Error(
        `部分拖选复制应等于所选文本: 剪贴板=${JSON.stringify(dragCopied.slice(0, 60))} 选区=${JSON.stringify(dragSel.slice(0, 60))}`,
      );
    }
    console.log(
      `PASS 1b: 真实鼠标部分拖选（${dragSel.length} 字）→ Cmd+C 得到所选文本 ${JSON.stringify(dragCopied)}`,
    );

    // ---- 1c. 保持选区右键 →「复制选中内容」→ 所选文本本身 ----
    await page.mouse.click(vh.x + 20, vh.y + vh.h / 2, {button: 'right'});
    await page.getByText('复制选中内容', {exact: true}).waitFor({timeout: 5000});
    await page.getByText('复制选中内容', {exact: true}).click();
    await page.waitForTimeout(300);
    const selCopied = await readClip();
    if (selCopied !== dragSel) {
      throw new Error(
        `「复制选中内容」应等于所选文本: ${JSON.stringify(selCopied.slice(0, 60))}`,
      );
    }
    console.log('PASS 1c: 右键「复制选中内容」得到所选文本');

    // ---- 2. 全选种子气泡 vs 右键「复制 Markdown」，两者应一致（整条源码） ----
    // 目标气泡 = 带源行号块最多的那个（即 mdHistory 种子气泡）
    await page.evaluate(() => window.getSelection().removeAllRanges());
    const richest = await page.evaluate(() => {
      const bubbles = Array.from(document.querySelectorAll('.hm-md'));
      let best = -1;
      let bestN = -1;
      bubbles.forEach((b, i) => {
        const n = b.querySelectorAll('[data-md-map]').length;
        if (n > bestN) {
          bestN = n;
          best = i;
        }
      });
      return best;
    });
    await page.evaluate(i => {
      const b = document.querySelectorAll('.hm-md')[i];
      const range = document.createRange();
      range.selectNodeContents(b);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);
    }, richest);
    await page.keyboard.press('ControlOrMeta+c');
    const wholeSelect = await readClip();
    console.log('>> 全选气泡复制（前 80 字）:', JSON.stringify(wholeSelect.slice(0, 80)));

    const bubbleLoc = page.locator('.hm-md').nth(richest);
    await bubbleLoc.scrollIntoViewIfNeeded();
    const bubbleBox = await bubbleLoc.boundingBox();
    await page.evaluate(() => window.getSelection().removeAllRanges());
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
    console.log(
      `PASS 2: 全选拖选复制 ≡ 右键「复制 Markdown」（整条源码，${wholeMenu.trim().length} 字）`,
    );

    // ---- 3. 右键「复制纯文本」→ 渲染后文本（无 # 行首） ----
    await page.mouse.click(bubbleBox.x + 30, bubbleBox.y + 10, {button: 'right'});
    await page.getByText('复制纯文本', {exact: true}).waitFor({timeout: 5000});
    await page.getByText('复制纯文本', {exact: true}).click();
    await page.waitForTimeout(300);
    const plain = await readClip();
    if (!plain.trim()) {
      throw new Error('「复制纯文本」剪贴板为空');
    }
    if (!plain.includes(HEADING_TEXT) || /^#{1,6} /m.test(plain)) {
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

    console.log('OK web 端 markdown 复制三入口全部通过');
  } finally {
    await browser.close().catch(() => {});
    vite.kill();
    await gw.close();
  }
}

main().catch(e => {
  console.error('[FAIL]', e.message);
  process.exit(1);
});
