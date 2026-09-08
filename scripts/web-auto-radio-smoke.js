/**
 * web-auto-radio-smoke.js — 自动连接互斥单选冒烟（Playwright，只读 UI 验证）。
 *
 * 前置：`npx vite` 已运行（localhost:5188）。流程：添加两条配置 → 首页卡片
 * 点「自动连接」圆波单选（选中卡片出现「默认」标签）→ 选另一条自动顶替 →
 * 再点取消 → 编辑页不再有自动连接开关。
 * 选中归属用 boundingBox 判定：「默认」标签与所选卡片名称同一行。
 *
 * 用法：node scripts/web-auto-radio-smoke.js
 */

const fs = require('node:fs');
const {chromium} = require('playwright-core');

// Chromium 路径由 playwright-core 按自身版本解析（默认 ~/Library/Caches/ms-playwright，
// 可用 PLAYWRIGHT_BROWSERS_PATH 覆盖），升级依赖后重跑下方安装命令即可，勿硬编码版本目录。
const EXE = chromium.executablePath();
if (!fs.existsSync(EXE)) {
  console.error(`未找到 Chromium：${EXE}`);
  console.error('请先安装：npx playwright-core install chromium');
  process.exit(1);
}
const BASE = 'http://localhost:5188/';
const OUT = 'docs/screenshots';

async function addProfile(page, name, direct) {
  await page.getByText('＋ 添加配置').click();
  await page.getByText('连接类型').waitFor({timeout: 5000});
  if (direct) {
    await page.getByText('直连', {exact: true}).click();
    await page.getByPlaceholder('127.0.0.1').waitFor({timeout: 5000});
  } else {
    await page.getByPlaceholder('例如 192.168.1.10').fill('10.0.0.9');
  }
  await page.getByPlaceholder(
    direct ? '例如：本机 gateway' : '例如：公司服务器',
  ).fill(name);
  await page.getByText('保存', {exact: true}).click();
  await page.getByText(name).waitFor({timeout: 5000});
}

async function defaultTagRow(page) {
  const tag = await page.getByText('默认', {exact: true}).boundingBox();
  if (!tag) {
    return null;
  }
  const a = await page.getByText('配置甲').boundingBox();
  const b = await page.getByText('配置乙').boundingBox();
  if (!a || !b) {
    throw new Error('测试配置卡片缺失');
  }
  return Math.abs(tag.y - a.y) <= Math.abs(tag.y - b.y) ? '甲' : '乙';
}

async function main() {
  const browser = await chromium.launch({executablePath: EXE, headless: true});
  const page = await browser.newPage({viewport: {width: 900, height: 900}});
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));

  await page.goto(BASE, {waitUntil: 'domcontentloaded'});
  await page.waitForTimeout(1500);

  // 1. 两条配置；初始无自动连接
  await addProfile(page, '配置甲', true);
  await addProfile(page, '配置乙', false);
  if ((await page.getByText('默认', {exact: true}).count()) !== 0) {
    throw new Error('初始状态不应有「默认」');
  }

  // 2. 选甲 → 默认在甲行
  await page.getByText('自动连接').nth(0).click();
  let row = await defaultTagRow(page);
  if (row !== '甲') {
    throw new Error(`点甲后默认应在甲行，实际：${row}`);
  }
  await page.screenshot({path: `${OUT}/web-auto-1-first.png`});

  // 3. 选乙 → 互斥顶替，仍只有一个默认且在乙行
  await page.getByText('自动连接').nth(1).click();
  if ((await page.getByText('默认', {exact: true}).count()) !== 1) {
    throw new Error('互斥单选后应只剩一个「默认」');
  }
  row = await defaultTagRow(page);
  if (row !== '乙') {
    throw new Error(`选乙后默认应在乙行，实际：${row}`);
  }
  await page.screenshot({path: `${OUT}/web-auto-2-switched.png`});

  // 4. 再点乙 → 取消自动连接
  await page.getByText('自动连接').nth(1).click();
  if ((await page.getByText('默认', {exact: true}).count()) !== 0) {
    throw new Error('再次点击应取消自动连接');
  }

  // 5. 编辑页不再有自动连接开关
  await page.getByText('编辑').nth(0).click();
  await page.getByText('连接类型').waitFor({timeout: 5000});
  if ((await page.getByText('打开应用后自动连接').count()) !== 0) {
    throw new Error('编辑页不应再有自动连接开关');
  }
  await page.screenshot({path: `${OUT}/web-auto-3-edit.png`});

  console.log('OK 自动连接互斥单选通过：首页单选顶替/可取消，编辑页无开关');
  await browser.close();
}

main().catch(e => {
  console.error('[FAIL]', e.message);
  process.exit(1);
});
