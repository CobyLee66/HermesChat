/**
 * web-image-viewer-smoke.js — 历史图片点击全屏查看原图的端到端冒烟。
 * 使用 mock-gateway 注入 data URL 假图片，真实 vite build/preview + Playwright，
 * 验证缩略图 → 原图全屏（contain）→ Escape / 关闭按钮；全程不打 live gateway。
 *
 * 用法：node scripts/web-image-viewer-smoke.js
 * 端口可用 SMOKE_MOCK_PORT / SMOKE_VITE_PORT 覆盖。
 */

const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright-core');

const {startMockGateway} = require('./mock-gateway');

const ROOT = path.join(__dirname, '..');
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 9220);
const VITE_PORT = Number(process.env.SMOKE_VITE_PORT || 5196);
const SESSION_TITLE = '图片查看冒烟';
const IMAGE_URI =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const EXE = chromium.executablePath();
if (!fs.existsSync(EXE)) {
  console.error(`未找到 Chromium：${EXE}`);
  console.error('请先安装：npx playwright-core install chromium');
  process.exit(1);
}

let gw;

async function main() {
  gw = await startMockGateway({
    port: MOCK_PORT,
    title: SESSION_TITLE,
    extraHistory: [{role: 'user', text: IMAGE_URI}],
  });
  console.log(`>> mock gateway: http://127.0.0.1:${MOCK_PORT}`);

  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const viteEnv = {...process.env, HERMES_VITE_UPSTREAM: `http://127.0.0.1:${MOCK_PORT}`};
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
  const pageErrors = [];
  try {
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

    page = await (await browser.newContext({viewport: {width: 900, height: 900}})).newPage();
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.addInitScript(() => localStorage.setItem('hermes.locale.v1', 'zh-CN'));
    await page.goto(viteUrl, {waitUntil: 'domcontentloaded'});
    await page.waitForTimeout(1200);
    await page.getByText('＋ 添加配置').click();
    await page.getByText('连接类型').waitFor({timeout: 5000});
    await page.getByText('直连', {exact: true}).click();
    await page.getByPlaceholder('例如：本机 gateway').fill('图片冒烟-直连');
    await page.getByText('保存', {exact: true}).click();
    await page.getByText('图片冒烟-直连').waitFor({timeout: 5000});
    await page.getByText('图片冒烟-直连').click();
    await page.waitForSelector('[aria-label^="打开 profile"]', {timeout: 20000});
    await page.locator('[aria-label^="打开 profile"]').first().click();
    await page.getByText(SESSION_TITLE, {exact: true}).waitFor({timeout: 10000});
    await page.getByText(SESSION_TITLE, {exact: true}).click();

    const thumbnail = page.locator('[aria-label="查看原图"]').first();
    await thumbnail.waitFor({timeout: 20000});
    await thumbnail.click();

    const full = page.locator('[data-testid="image-viewer-full"]');
    await full.waitFor({timeout: 5000});
    const proof = await full.evaluate(el => {
      const background = el.querySelector('div');
      const image = el.querySelector('img');
      const rect = el.getBoundingClientRect();
      return {
        src: image?.getAttribute('src') || '',
        backgroundSize: background ? getComputedStyle(background).backgroundSize : '',
        width: rect.width,
        height: rect.height,
      };
    });
    if (proof.src !== IMAGE_URI) {
      throw new Error('全屏层未使用原始图片 URI');
    }
    if (proof.backgroundSize !== 'contain') {
      throw new Error(`全屏图片 resizeMode 异常：${proof.backgroundSize}`);
    }
    if (proof.width < 800 || proof.height < 800) {
      throw new Error(`全屏层尺寸异常：${proof.width}×${proof.height}`);
    }
    console.log('PASS 1: 缩略图点击后以原 URI + contain 全屏显示');

    await page.keyboard.press('Escape');
    await full.waitFor({state: 'detached', timeout: 5000});
    console.log('PASS 2: Escape 关闭全屏原图');

    await page.waitForTimeout(700);
    await thumbnail.click();
    await full.waitFor({timeout: 5000});
    await page.locator('[aria-label="关闭"]').click();
    await full.waitFor({state: 'detached', timeout: 5000});
    console.log('PASS 3: 关闭按钮关闭全屏原图');

    if (pageErrors.length > 0) {
      throw new Error(`页面异常：${pageErrors.join('\n')}`);
    }
    console.log('web-image-viewer-smoke: ALL PASS');
  } finally {
    if (page) {
      await page
        .screenshot({path: 'docs/screenshots/web-image-viewer-smoke.png'})
        .catch(() => {});
    }
    await browser.close();
    vite.kill();
    if (gw) {
      await gw.close();
    }
  }
}

main().catch(e => {
  console.error('FAIL:', e.message || e);
  process.exit(1);
});
