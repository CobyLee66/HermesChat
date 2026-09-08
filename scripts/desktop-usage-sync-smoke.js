/**
 * desktop-usage-sync-smoke.js — 桌面壳（Electron）「重进会话主动同步上下文
 * 信息」实测：打开/重进会话后顶栏「模型 · 上下文用量」不等新消息输出即正确。
 *
 * 全程**不打真实 gateway**：本地起 scripts/mock-gateway.js（内存态）。保真点：
 * resume 返回的 info **不含 usage**（真实服务端口径，docs/protocol.md §3），
 * 客户端必须主动调 `session.usage` 只读 RPC 才能拿到上下文用量。验证：
 *  1. 首次打开会话：顶栏 ≤3s 出现「3.5k/8k」（mock usage 3450/8000），未发任何消息；
 *  2. 客户端在 resume 后调 `session.usage {session_id: live sid}`；
 *  3. 发消息（message.complete 带 usage 100/8000 落地）→ 顶栏变「100/8k」；
 *  4. 重进会话：顶栏再次变回「3.5k/8k」——读回覆盖了 resume info 的 usage 缺口，
 *     无需等新消息输出。
 *
 * 前置：`npm run web:build && npm run desktop:build` 已构建。
 * 用法：node scripts/desktop-usage-sync-smoke.js
 */

const fs = require('node:fs');
const path = require('node:path');
const {_electron} = require('playwright-core');

const {startMockGateway, MOCK_TITLE} = require('./mock-gateway');

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
const MOCK_PORT = 9199;
const PROFILE_NAME = '用量同步-测试';
const USER_DATA = '/tmp/hermes-desktop-usage-smoke';

/** 页面上是否存在可见的含 substr 文本（副标题断言用，不究具体层级）。 */
async function hasText(page, substr) {
  return page.evaluate(s => {
    for (const el of document.querySelectorAll('div,span')) {
      if ((el.textContent ?? '').includes(s)) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return true;
        }
      }
    }
    return false;
  }, substr);
}

/** 轮询等待文本出现（默认 3s）。 */
async function waitForText(page, substr, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await hasText(page, substr)) {
      return true;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await page.waitForTimeout(100);
  }
}

async function main() {
  // 流式 2 段快速回完（只为了 message.complete 带 usage 落地，不需长文本）
  const gw = await startMockGateway({
    port: MOCK_PORT,
    title: MOCK_TITLE,
    stream: {chunks: 2, intervalMs: 100},
  });
  console.log(`>> mock gateway: http://127.0.0.1:${MOCK_PORT}`);

  // 隔离 userData（上次残留配置卡片会干扰 getByText 定位）
  fs.rmSync(USER_DATA, {recursive: true, force: true});
  const electronApp = await _electron.launch({
    executablePath: EXE,
    args: [path.join(__dirname, '..', 'desktop-smoke-launcher.js')],
    env: {...process.env, HERMES_SMOKE_USER_DATA: USER_DATA},
  });
  try {
    const page = await electronApp.firstWindow();
    page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
    await electronApp.evaluate(({BrowserWindow}) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setSize(1400, 900);
      }
    });

    await page.waitForSelector('text=Hermes', {timeout: 20000});
    await page.waitForTimeout(1000);

    // 1. 添加直连配置（指向 mock gateway）
    await page.getByText('＋ 添加配置').click();
    await page.getByText('连接类型').waitFor({timeout: 5000});
    await page
      .getByText('SSH 隧道', {exact: true})
      .locator('xpath=../..')
      .getByText('直连', {exact: true})
      .click();
    await page.getByPlaceholder('127.0.0.1').waitFor({timeout: 5000});
    await page.getByPlaceholder('127.0.0.1').fill('127.0.0.1');
    await page.getByPlaceholder('9119').fill(String(MOCK_PORT));
    await page.getByPlaceholder('例如：本机 gateway').fill(PROFILE_NAME);
    await page.getByText('保存', {exact: true}).click();
    await page.getByText(PROFILE_NAME).waitFor({timeout: 5000});
    await page.getByText(PROFILE_NAME).click();
    await page.waitForSelector('[aria-label^="打开 profile"]', {timeout: 20000});
    await page.waitForTimeout(1200);

    // 2. 进 profile → 打开会话（resume info 无 usage，顶栏应靠读回出现用量）
    await page.locator('[aria-label^="打开 profile"]').first().click();
    await page.getByText(MOCK_TITLE, {exact: true}).first().waitFor({timeout: 20000});
    await page.waitForTimeout(800);
    await page.getByText(MOCK_TITLE, {exact: true}).first().click();
    await page.getByPlaceholder('发消息…').waitFor({timeout: 20000});

    // 3. 断言 1：不发任何消息，顶栏 ≤3s 出现 mock usage（3450/8000 → 3.5k/8k）
    const usageShown = await waitForText(page, '3.5k/8k');
    await page.screenshot({path: `${OUT}/desktop-usage-sync-1-open.png`});
    if (!usageShown) {
      throw new Error('打开会话后顶栏未出现上下文用量（session.usage 读回未生效）');
    }
    console.log('PASS 1: 打开会话后顶栏 ≤3s 显示 3.5k/8k（未发任何消息）');

    // 4. 断言 2：客户端在 resume 之后调了 session.usage（live sid）
    const idxResume = gw.state.calls.findIndex(c => c.method === 'session.resume');
    const usageCalls = gw.state.calls.filter(c => c.method === 'session.usage');
    if (idxResume < 0 || usageCalls.length === 0) {
      throw new Error(
        `调用流水不符（resume=${idxResume}，session.usage=${usageCalls.length} 次）`,
      );
    }
    if (usageCalls.some(c => c.params.session_id !== 'live0001')) {
      throw new Error('session.usage 未用 live sid 调用');
    }
    console.log('PASS 2: 客户端在 resume 后调 session.usage 只读 RPC（live sid）');

    // 5. 发消息 → message.complete 带 usage(100/8000) → 顶栏变 100/8k
    const input = page.getByPlaceholder('发消息…');
    await input.click();
    await input.fill('同步测试');
    await page.keyboard.press('Enter');
    const afterSend = await waitForText(page, '100/8k', 8000);
    await page.screenshot({path: `${OUT}/desktop-usage-sync-2-after-send.png`});
    if (!afterSend) {
      throw new Error('message.complete 后顶栏用量未更新为 100/8k');
    }
    console.log('PASS 3: 发消息后顶栏随 complete 事件更新为 100/8k（既有链路）');

    // 6. 重进会话（wide 三栏下会话行同屏可见，直接再点）：
    //    resume info 依旧无 usage → 顶栏应靠读回再次显示 3.5k/8k
    await page.getByText(MOCK_TITLE, {exact: true}).first().click();
    await page.getByPlaceholder('发消息…').waitFor({timeout: 20000});
    const reentered = await waitForText(page, '3.5k/8k', 4000);
    await page.screenshot({path: `${OUT}/desktop-usage-sync-3-reenter.png`});
    if (!reentered) {
      throw new Error('重进会话后顶栏未主动同步上下文用量');
    }
    const reenterReads = gw.state.calls.filter(
      c => c.method === 'session.usage',
    ).length;
    if (reenterReads < 2) {
      throw new Error(`重进后未再次读回 session.usage（共 ${reenterReads} 次）`);
    }
    console.log('PASS 4: 重进会话顶栏再次即时显示 3.5k/8k（读回覆盖 usage 缺口）');

    console.log('OK Electron 重进会话主动同步上下文信息通过');
  } finally {
    await electronApp.close();
    await gw.close();
  }
}

main().catch(e => {
  console.error('[FAIL]', e.message);
  process.exit(1);
});
