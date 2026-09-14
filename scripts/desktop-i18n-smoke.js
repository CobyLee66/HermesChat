/**
 * desktop-i18n-smoke.js — 桌面壳（Electron）多语言冒烟（D047 修复回归）。
 *
 * 全程不打真实 gateway：本地 mock-gateway。验证三件事：
 *  1. 语言切换控件在连接主页与 profile 选择首屏都有、进入会话/聊天视图后
 *     不再出现（ProfileRail 底部已删）；
 *  2. 切换语言后全界面即时切换（含 ProfileListPane 右上角「退出连接」——
 *     曾是漏迁移的 JSX 硬编码文案，语言切换后仍中文）；
 *  3. 窗口标题跟随当前视图（曾卡死在「Edit profile」：ProfileEditModal 的
 *     嵌套 NavigationContainer 劫持 document.title 后无人恢复）。
 *
 * 流程：干净 userData 启动（跟随系统=中文）→ localStorage 预置 en + 刷新
 * （验证持久化恢复）→ ConnectionHome 切换往返 → 添加直连配置连 mock →
 * ProfileListPane（标题=Sessions）→ 进 profile（标题=profile 名，无切换控件）
 * → 编辑资料弹层（标题=Edit profile → 关闭恢复）。
 *
 * 前置：`npm run web:build && npm run desktop:build` 已构建；本机系统语言
 * 需为中文（首屏断言「添加配置」中文文案；如系统为英文，首屏断言会失败）。
 * 用法：node scripts/desktop-i18n-smoke.js
 */

const fs = require('node:fs');
const path = require('node:path');
const {_electron} = require('playwright-core');

const {startMockGateway} = require('./mock-gateway');

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
const MOCK_PORT = 9198;
const USER_DATA = '/tmp/hermes-desktop-i18n-smoke';
const PROFILE_NAME = 'i18n-profile';
const LOCALE_KEY = 'hermes.locale.v1';

/** 语言切换控件实例数（accessibilityLabel 随语言变化，两种都数）。 */
async function toggleCount(page) {
  return page
    .locator('[aria-label="Language"], [aria-label="切换语言"]')
    .count();
}

const TOGGLE_SEL = '[aria-label="Language"], [aria-label="切换语言"]';

/** 循环点按切换控件（三态循环，最多 3 次必回到目标档），直到目标文案出现。 */
async function clickToggleUntil(page, needle) {
  for (let i = 0; i < 3; i++) {
    await page.locator(TOGGLE_SEL).first().click();
    try {
      await page.getByText(needle, {exact: true}).first().waitFor({timeout: 2500});
      return;
    } catch {
      // 当前档不对，继续点下一档
    }
  }
  throw new Error(`切换语言后未出现预期文案：${needle}`);
}

async function windowTitle(electronApp) {
  return electronApp.evaluate(({BrowserWindow}) => {
    const win = BrowserWindow.getAllWindows()[0];
    return win ? win.getTitle() : '';
  });
}

async function main() {
  const gw = await startMockGateway({port: MOCK_PORT});
  console.log(`>> mock gateway: http://127.0.0.1:${MOCK_PORT}`);

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

    // 0. 干净启动：跟随系统（本机=中文）→ 中文连接主页
    await page.getByText('＋ 添加配置', {exact: true}).waitFor({timeout: 20000});
    console.log('PASS 0: 跟随系统语言首屏（本机中文 → 中文界面）');

    // 1. localStorage 预置 en + 刷新：持久化恢复生效，界面切英文
    await page.evaluate(
      ([k, v]) => localStorage.setItem(k, v),
      [LOCALE_KEY, 'en'],
    );
    await page.reload();
    await page.getByText('＋ Add profile', {exact: true}).waitFor({timeout: 15000});
    if ((await toggleCount(page)) !== 1) {
      throw new Error('连接主页应有 1 个语言切换控件');
    }
    const homeTitle = await windowTitle(electronApp);
    if (homeTitle !== 'Hermes Chat') {
      throw new Error(`连接主页窗口标题应为 Hermes Chat，实际：${homeTitle}`);
    }
    console.log('PASS 1: 预置 en 持久化恢复 → 英文界面；连接主页有切换控件');

    // 2. 连接主页切换往返：en →（点按直到）zh → en
    await clickToggleUntil(page, '＋ 添加配置');
    await clickToggleUntil(page, '＋ Add profile');
    console.log('PASS 2: 连接主页语言切换即时生效（en↔zh 往返）');

    // 3. 英文界面添加直连配置并连接（表单默认 SSH 类型，先切 Direct）
    await page.getByText('＋ Add profile', {exact: true}).click();
    await page.getByText('Connection type', {exact: true}).waitFor({timeout: 5000});
    await page.getByText('Direct', {exact: true}).click();
    await page.getByPlaceholder('e.g. local gateway').waitFor({timeout: 5000});
    await page.getByPlaceholder('e.g. local gateway').fill(PROFILE_NAME);
    await page.getByPlaceholder('9119').fill(String(MOCK_PORT));
    await page.getByText('Save', {exact: true}).click();
    await page.getByText(PROFILE_NAME, {exact: true}).waitFor({timeout: 5000});
    await page.getByText(PROFILE_NAME, {exact: true}).click();
    // 连接成功 → desktop 壳 ProfileListPane（未选 profile 的全宽首屏）
    await page.getByText('Disconnect', {exact: true}).waitFor({timeout: 20000});

    // 4. ProfileListPane：右上角 Disconnect 随语言（曾是硬编码中文）、
    //    有切换控件、窗口标题 = Sessions
    await page.waitForTimeout(800);
    const paneToggle = await toggleCount(page);
    if (paneToggle !== 1) {
      throw new Error(`Profile 首屏应有 1 个语言切换控件，实际 ${paneToggle}`);
    }
    const paneTitle = await windowTitle(electronApp);
    if (paneTitle !== 'Sessions') {
      throw new Error(`Profile 首屏窗口标题应为 Sessions，实际：${paneTitle}`);
    }
    console.log('PASS 3: Profile 首屏 Disconnect 英文（漏迁移已修）+ 标题 = Sessions');

    // 5. 切到中文：Disconnect → 退出连接 即时切换（再切回英文）
    await clickToggleUntil(page, '退出连接');
    await clickToggleUntil(page, 'Disconnect');
    console.log('PASS 4: 退出连接按钮随语言即时切换（zh↔en 往返）');

    // 6. 选 profile 进会话视图：切换控件消失（rail 已删）、标题 = profile 名
    //    （mock 网关返回的 hermes profile 名为 'mock profile'，非连接配置名）
    await page.locator('[aria-label^="Open profile"]').first().click();
    await page.getByText('New chat', {exact: true}).first().waitFor({timeout: 20000});
    await page.waitForTimeout(800);
    const chatToggle = await toggleCount(page);
    if (chatToggle !== 0) {
      throw new Error(`会话视图不应再有语言切换控件，实际 ${chatToggle}`);
    }
    const chatTitle = await windowTitle(electronApp);
    if (chatTitle !== 'mock profile') {
      throw new Error(`会话视图窗口标题应为 profile 名，实际：${chatTitle}`);
    }
    console.log('PASS 5: 会话视图无切换控件（rail 已删）+ 标题 = profile 名');

    // 7. 编辑资料弹层：标题 → Edit profile；关闭后恢复
    await page.getByText('‹ Back', {exact: true}).click();
    await page.getByText('Disconnect', {exact: true}).waitFor({timeout: 8000});
    await page.locator('[aria-label^="Open profile"]').first().waitFor({timeout: 8000});
    await page.getByText('Edit', {exact: true}).first().click();
    await page.getByText('Edit profile', {exact: true}).first().waitFor({timeout: 8000});
    await page.waitForTimeout(600);
    const editTitle = await windowTitle(electronApp);
    if (editTitle !== 'Edit profile') {
      throw new Error(`编辑资料弹层窗口标题应为 Edit profile，实际：${editTitle}`);
    }
    await page.getByText('‹ Back', {exact: true}).first().click();
    await page.waitForTimeout(600);
    const backTitle = await windowTitle(electronApp);
    if (backTitle !== 'Sessions') {
      throw new Error(`弹层关闭后标题应恢复 Sessions，实际：${backTitle}`);
    }
    console.log('PASS 6: 编辑资料弹层标题 Edit profile → 关闭恢复（不再卡死）');

    console.log('OK Electron 桌面多语言冒烟全部通过');
  } finally {
    await electronApp.close();
    await gw.close();
  }
}

main().catch(e => {
  console.error('[FAIL]', e.message);
  process.exit(1);
});
