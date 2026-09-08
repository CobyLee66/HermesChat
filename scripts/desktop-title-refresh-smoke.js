/**
 * desktop-title-refresh-smoke.js — 桌面壳（Electron）会话标题即时刷新 + 顶栏
 * 菜单重命名/删除实测（D032）。
 *
 * 全程**不打真实 gateway**：本地起 scripts/mock-gateway.js（内存态，/title
 * 只改内存），验证：
 *  1. `/title` 命令（服务端写库不推事件）后，顶栏 + 左侧会话行 ≤3s 即时更新；
 *  2. 客户端在命令后主动调 `session.title` 只读形式读回；
 *  3. ⋯ 菜单「重命名会话」（RPC 写形式 + 弹窗预填）两处即时刷新；
 *  4. ⋯ 菜单「删除会话」确认后聊天列关闭、session.delete 已调。
 *
 * 前置：`npm run web:build && npm run desktop:build` 已构建。
 * 用法：node scripts/desktop-title-refresh-smoke.js
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
const NEW_TITLE = '标题刷新测试';
const USER_DATA = '/tmp/hermes-desktop-title-smoke';

/** 标题文本出现的位置（几何判定：顶栏 y<60，会话列 x<320，聊天列两者都不算）。 */
function locateTitle(page, text) {
  return page.evaluate(t => {
    const out = {header: false, list: false};
    for (const el of document.querySelectorAll('div,span')) {
      if ((el.textContent ?? '').trim() !== t) {
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) {
        continue;
      }
      if (r.y < 60) {
        out.header = true;
      } else if (r.x < 320) {
        out.list = true;
      }
    }
    return out;
  }, text);
}

async function main() {
  const gw = await startMockGateway({port: MOCK_PORT, title: MOCK_TITLE});
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
    // 拉到 wide 断点（≥1280 三栏），会话列与聊天列同屏才能一次断言两处
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
    await page.getByPlaceholder('例如：本机 gateway').fill('标题刷新-测试');
    await page.getByText('保存', {exact: true}).click();
    await page.getByText('标题刷新-测试').waitFor({timeout: 5000});
    await page.getByText('标题刷新-测试').click();
    await page.waitForSelector('[aria-label^="打开 profile"]', {timeout: 20000});
    await page.waitForTimeout(1200);

    // 2. 进 profile → 会话列出现 mock 会话（标题为原标题）
    await page.locator('[aria-label^="打开 profile"]').first().click();
    await page.getByText(MOCK_TITLE, {exact: true}).first().waitFor({timeout: 20000});
    await page.waitForTimeout(800);

    // 3. 打开会话：顶栏应显示原标题（种子）
    await page.getByText(MOCK_TITLE, {exact: true}).first().click();
    await page.getByPlaceholder('发消息…').waitFor({timeout: 20000});
    await page.waitForTimeout(1200);
    const before = await locateTitle(page, MOCK_TITLE);
    console.log('>> 改名前后位置（顶栏/会话列）:', JSON.stringify(before));
    if (!before.header || !before.list) {
      throw new Error('打开会话后顶栏/会话列未同时显示原标题（种子标题缺失）');
    }
    await page.screenshot({path: `${OUT}/desktop-title-refresh-1-before.png`});

    // 4. 发 /title 命令（mock 侧等价于服务端 slash worker 写库、不推事件）
    const input = page.getByPlaceholder('发消息…');
    await input.click();
    await input.fill(`/title ${NEW_TITLE}`);
    await page.keyboard.press('Enter');

    // 5. 不重进会话、不重连：3s 内两处都应变成新标题
    const deadline = Date.now() + 3000;
    let after = {header: false, list: false};
    for (;;) {
      after = await locateTitle(page, NEW_TITLE);
      if (after.header && after.list) {
        break;
      }
      if (Date.now() > deadline) {
        break;
      }
      await page.waitForTimeout(100);
    }
    console.log('>> 改名后位置（顶栏/会话列）:', JSON.stringify(after));
    await page.screenshot({path: `${OUT}/desktop-title-refresh-2-after.png`});
    if (!after.header) {
      throw new Error('顶栏标题未即时刷新（仍是旧标题）');
    }
    if (!after.list) {
      throw new Error('会话列表行未即时刷新（仍是旧标题）');
    }
    console.log('PASS 1: /title 后顶栏 + 会话列 ≤3s 即时刷新（未重进/未重连）');

    // 6. 调用顺序：slash.exec（命令）→ session.title 只读形式（客户端读回）
    const idxSlash = gw.state.calls.findIndex(c => c.method === 'slash.exec');
    const idxRead = gw.state.calls.findIndex(
      c =>
        c.method === 'session.title' &&
        typeof c.params?.title !== 'string',
    );
    if (idxSlash < 0 || idxRead < 0 || idxRead < idxSlash) {
      throw new Error(
        `调用顺序不符（slash.exec=${idxSlash}，session.title 读回=${idxRead}）`,
      );
    }
    console.log('PASS 2: 客户端在 slash.exec 之后调 session.title 只读形式读回标题');

    // 7. 顶栏 ⋯ 菜单「重命名会话」：弹窗预填当前标题 → 提交后两处即时刷新
    //    （走 session.title RPC 写形式，非 slash 命令）
    const MENU_TITLE = '菜单改名标题';
    await page.getByText('⋯', {exact: true}).click();
    await page.getByText('重命名会话', {exact: true}).waitFor({timeout: 5000});
    // 等 250ms 淡入动画结束再截图（RNW Modal fade）
    await page.waitForTimeout(400);
    await page.screenshot({path: `${OUT}/desktop-title-refresh-3-menu.png`});
    await page.getByText('重命名会话', {exact: true}).click();
    const renameInput = page.getByPlaceholder('输入新的会话标题');
    await renameInput.waitFor({timeout: 5000});
    const prefilled = await renameInput.inputValue();
    if (prefilled !== NEW_TITLE) {
      throw new Error(`改名弹窗未预填当前标题：${JSON.stringify(prefilled)}`);
    }
    await renameInput.fill(MENU_TITLE);
    await page.getByText('重命名', {exact: true}).click();
    const menuDeadline = Date.now() + 3000;
    let menuAfter = {header: false, list: false};
    for (;;) {
      menuAfter = await locateTitle(page, MENU_TITLE);
      if (menuAfter.header && menuAfter.list) {
        break;
      }
      if (Date.now() > menuDeadline) {
        break;
      }
      await page.waitForTimeout(100);
    }
    console.log('>> 菜单改名后位置（顶栏/会话列）:', JSON.stringify(menuAfter));
    // RNW Modal 关闭时保持 DOM 挂载做 250ms 淡出（pointerEvents:none，不影响
    // 交互），立即截图会拍到旧弹窗淡出的瞬态——等动画结束再拍
    await page.waitForTimeout(400);
    await page.screenshot({path: `${OUT}/desktop-title-refresh-4-renamed.png`});
    if (!menuAfter.header || !menuAfter.list) {
      throw new Error(
        `菜单改名未即时刷新（顶栏=${menuAfter.header}，会话列=${menuAfter.list}）`,
      );
    }
    const rpcRename = gw.state.calls.find(
      c =>
        c.method === 'session.title' &&
        typeof c.params?.title === 'string' &&
        c.params.title === MENU_TITLE,
    );
    if (!rpcRename) {
      throw new Error('菜单改名未走 session.title RPC 写形式');
    }
    console.log('PASS 3: ⋯ 菜单重命名（RPC 写形式）两处即时刷新 + 弹窗预填正确');

    // 8. 顶栏 ⋯ 菜单「删除会话」：确认后关聊天列、列表行消失。
    //    mock 保真真实网关 id 语义：delete 只认持久化 id（live sid 4007）、
    //    活动会话 4023、close 只认 live sid——本用例同时验证客户端的
    //    close(live)+delete(stored) 正确配合
    await page.getByText('⋯', {exact: true}).click();
    await page.getByText('删除会话', {exact: true}).waitFor({timeout: 5000});
    await page.getByText('删除会话', {exact: true}).click();
    await page.getByText('确定删除', {exact: false}).waitFor({timeout: 5000});
    await page.getByText('确定', {exact: true}).click();
    await page.getByText('从会话列表选择一个会话', {exact: true}).waitFor({
      timeout: 8000,
    });
    if (!gw.state.calls.some(c => c.method === 'session.delete')) {
      throw new Error('删除未调用 session.delete RPC');
    }
    // 列表行按持久化 id 过滤：行应消失（live sid 过滤会漏，回归此处先炸）
    await page.getByText(MENU_TITLE, {exact: true}).waitFor({state: 'detached', timeout: 5000});
    const delCalls = gw.state.calls.filter(c => c.method === 'session.delete');
    // 首次 delete（4023）+ close 后重试（成功）= 2 次，且都用持久化 id
    if (
      delCalls.length !== 2 ||
      !delCalls.every(c => c.params.session_id === 'stored-mock-0001')
    ) {
      throw new Error(
        `session.delete 调用参数异常：${JSON.stringify(delCalls.map(c => c.params))}`,
      );
    }
    const closeCall = gw.state.calls.find(c => c.method === 'session.close');
    if (!closeCall || closeCall.params.session_id !== 'live0001') {
      throw new Error('4023 后未用 live sid 调 session.close');
    }
    await page.waitForTimeout(400);
    await page.screenshot({path: `${OUT}/desktop-title-refresh-5-deleted.png`});
    console.log('PASS 4: ⋯ 菜单删除会话 → close(live)+delete(stored) → 聊天列关、行消失');

    console.log('OK Electron 桌面会话标题即时刷新通过');
  } finally {
    await electronApp.close();
    await gw.close();
  }
}

main().catch(e => {
  console.error('[FAIL]', e.message);
  process.exit(1);
});
