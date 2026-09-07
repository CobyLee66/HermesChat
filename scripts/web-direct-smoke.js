/**
 * web-direct-smoke.js — 直连配置全流程冒烟（Playwright，只读验证）。
 *
 * 前置：`npx vite` 已运行（localhost:5188），本机 hermes 9119 可达。
 * 流程：添加配置 → 切「直连」类型（校验 gateway 字段出现）→ 填名称保存 →
 * 首页卡片显示「直连」标签与地址 → 点卡片直连本机 gateway → 进入 Profile 列表。
 * 只读浏览：停在 profile 列表，不点会话、不发送消息。
 *
 * 用法：node scripts/web-direct-smoke.js
 */

const {chromium} = require('playwright-core');

const EXE =
  '~/Library/Caches/ms-playwright/chromium_headless_shell-1234/' +
  'chrome-headless-shell-mac-arm64/chrome-headless-shell';
const BASE = 'http://localhost:5188/';
const OUT = 'docs/screenshots';

async function main() {
  const browser = await chromium.launch({executablePath: EXE, headless: true});
  const page = await browser.newPage({viewport: {width: 900, height: 900}});
  page.on('console', m => {
    if (m.type() === 'error') {
      console.log('[console.error]', m.text().slice(0, 300));
    }
  });
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));

  await page.goto(BASE, {waitUntil: 'domcontentloaded'});
  await page.waitForTimeout(1500);

  // 1. 添加配置 → 编辑页出现「连接类型」
  await page.getByText('＋ 添加配置').click();
  await page.getByText('连接类型').waitFor({timeout: 5000});
  await page.screenshot({path: `${OUT}/web-direct-1-edit-ssh.png`});

  // 2. 切直连：gateway 字段出现，默认值代填
  await page.getByText('直连', {exact: true}).click();
  await page.getByPlaceholder('127.0.0.1').waitFor({timeout: 5000});
  await page.screenshot({path: `${OUT}/web-direct-1b-edit-direct.png`});
  const hostVal = await page.getByPlaceholder('127.0.0.1').inputValue();
  const portVal = await page.getByPlaceholder('9119').inputValue();
  if (hostVal !== '127.0.0.1' || portVal !== '9119') {
    throw new Error(`直连默认值异常 host=${hostVal} port=${portVal}`);
  }

  // 3. 填名称 → 保存
  await page.getByPlaceholder('例如：本机 gateway').fill('本机直连-测试');
  await page.getByText('保存', {exact: true}).click();
  await page.getByText('本机直连-测试').waitFor({timeout: 5000});
  await page.screenshot({path: `${OUT}/web-direct-2-home-card.png`});

  // 4. 卡片应有「直连」标签与 host:port 地址行
  const cardText = await page.getByText('本机直连-测试').innerText();
  console.log('[card]', cardText);
  const addrVisible = await page
    .getByText('127.0.0.1:9119', {exact: true})
    .isVisible();
  if (!addrVisible) {
    throw new Error('卡片未显示直连地址 127.0.0.1:9119');
  }

  // 5. 点卡片 → 直连本机 gateway → Profile 列表
  await page.getByText('本机直连-测试').click();
  await page.waitForSelector('[aria-label^="打开 profile"]', {timeout: 20000});
  await page.waitForTimeout(1500); // 等 profile 列表拉取
  await page.screenshot({path: `${OUT}/web-direct-3-profiles.png`});
  console.log('OK 直连全流程通过：添加直连配置 → 连接 → 进入 profile 列表');

  await browser.close();
}

main().catch(e => {
  console.error('[FAIL]', e.message);
  process.exit(1);
});
