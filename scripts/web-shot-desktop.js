/**
 * web-shot-desktop.js — 桌面响应式布局截图脚本（Playwright，只读验证）。
 *
 * 前置：`npx vite` 已运行（localhost:5188），本机 hermes 9119 可达。
 * 流程：浏览器直连 → 桌面壳 Profile 列表 → 选第一个 profile → 会话列 +
 * 聊天空态；分别在 wide(1500)/medium(1100)/narrow(800) 三档宽度截图。
 * 只做只读浏览（不点会话行、不新建会话，避免对 live 服务做写操作）。
 *
 * 用法：node scripts/web-shot-desktop.js
 */

const {chromium} = require('playwright-core');

const EXE =
  '~/Library/Caches/ms-playwright/chromium_headless_shell-1234/' +
  'chrome-headless-shell-mac-arm64/chrome-headless-shell';
const BASE = 'http://localhost:5188/';
const OUT = 'docs/screenshots';

async function main() {
  const browser = await chromium.launch({executablePath: EXE, headless: true});
  const page = await browser.newPage({viewport: {width: 1500, height: 900}});
  page.on('console', m => {
    if (m.type() === 'error') {
      console.log('[console.error]', m.text().slice(0, 300));
    }
  });
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));

  await page.goto(BASE, {waitUntil: 'domcontentloaded'});
  await page.waitForTimeout(1500);

  // 浏览器直连（连本机 hermes）
  await page.getByText('⚡ 浏览器直连').click();
  await page.waitForSelector('[aria-label^="打开 profile"]', {timeout: 20000});
  await page.waitForTimeout(1500); // 等 profile 列表拉取
  await page.screenshot({path: `${OUT}/desktop-wide-1-profiles.png`});
  console.log('OK wide profiles');

  // 选第一个 profile → 三栏（会话列 + 聊天空态）
  await page.locator('[aria-label^="打开 profile"]').first().click();
  await page.waitForTimeout(2000); // 等会话列表拉取
  await page.screenshot({path: `${OUT}/desktop-wide-2-sessions.png`});
  console.log('OK wide sessions+chat');

  // medium 两栏
  await page.setViewportSize({width: 1100, height: 800});
  await page.waitForTimeout(800);
  await page.screenshot({path: `${OUT}/desktop-medium-2col.png`});
  console.log('OK medium');

  // narrow 单列（会话列表面）
  await page.setViewportSize({width: 800, height: 900});
  await page.waitForTimeout(800);
  await page.screenshot({path: `${OUT}/desktop-narrow-sessions.png`});
  console.log('OK narrow sessions');

  await browser.close();
  console.log('DONE');
}

main().catch(e => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
