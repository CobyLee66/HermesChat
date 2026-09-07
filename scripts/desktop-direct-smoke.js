/**
 * desktop-direct-smoke.js — 桌面壳（Electron）直连配置全流程冒烟（只读验证）。
 *
 * 前置：dist-web 与 desktop/dist 已构建（npm run web:build && npm run desktop:build），
 * 本机 hermes 9119 可达。流程：真实 Electron 启动（隔离 userData）→ 添加配置 →
 * 切「直连」→ 保存 → 点卡片 → 主进程 directConnect IPC（代理上游 + 代取 token）
 * → WS 就绪 → Profile 列表。只读浏览：停在 profile 列表。
 *
 * 用法：node scripts/desktop-direct-smoke.js
 */

const path = require('node:path');
const {_electron} = require('playwright-core');

const EXE = path.join(
  __dirname,
  '..',
  'node_modules',
  'electron',
  'dist',
  'Electron.app',
  'Contents',
  'MacOS',
  'Electron',
);
const OUT = 'docs/screenshots';

async function main() {
  const electronApp = await _electron.launch({
    executablePath: EXE,
    args: [path.join(__dirname, '..', 'desktop-smoke-launcher.js')],
  });
  const page = await electronApp.firstWindow();
  page.on('console', m => {
    if (m.type() === 'error') {
      console.log('[console.error]', m.text().slice(0, 300));
    }
  });
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));

  await page.waitForSelector('text=Hermes', {timeout: 20000});
  await page.waitForTimeout(1000);

  // 1. 添加配置 → 切直连
  await page.getByText('＋ 添加配置').click();
  await page.getByText('连接类型').waitFor({timeout: 5000});
  await page.getByText('直连', {exact: true}).click();
  await page.getByPlaceholder('127.0.0.1').waitFor({timeout: 5000});
  await page.screenshot({path: `${OUT}/desktop-direct-1-edit.png`});

  // 2. 填名称 → 保存 → 首页卡片
  await page.getByPlaceholder('例如：本机 gateway').fill('桌面直连-测试');
  await page.getByText('保存', {exact: true}).click();
  await page.getByText('桌面直连-测试').waitFor({timeout: 5000});
  await page.screenshot({path: `${OUT}/desktop-direct-2-home.png`});

  // 3. 点卡片 → 主进程直连 → Profile 列表
  await page.getByText('桌面直连-测试').click();
  await page.waitForSelector('[aria-label^="打开 profile"]', {timeout: 20000});
  await page.waitForTimeout(1500); // 等 profile 列表拉取
  await page.screenshot({path: `${OUT}/desktop-direct-3-profiles.png`});
  console.log('OK 桌面直连全流程通过：IPC directConnect → 回环代理 → WS 就绪');

  await electronApp.close();
}

main().catch(e => {
  console.error('[FAIL]', e.message);
  process.exit(1);
});
