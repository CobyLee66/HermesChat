/**
 * web-rename-smoke.js — 重命名会话弹窗冒烟（修复「点输入框弹窗自动关闭」）。
 *
 * 被测行为（根因：RNW 的 onPress 由 DOM click 冒泡触发，调用于 click 目标的
 * 首个 PressResponder 祖先；旧实现把卡片嵌在背景 TouchableOpacity 里，点
 * TextInput 冒泡命中背景 onPress 直接关弹窗——原生端 TextInput 抢占 responder
 * 无此问题，故仅桌面/web 复现。修复 = 背景层与卡片改兄弟节点，SessionListPanel
 * 先例）：
 *   1. 聊天页 ⋯ → 重命名会话：弹窗打开、输入框预填当前标题；
 *   2. 【核心回归】真实鼠标点击输入框 → 弹窗不得关闭，且键盘可直接编辑；
 *   3. 点「重命名」：弹窗关闭、mock 收到 session.title 写形式、
 *      头部/列表标题即时刷新；
 *   4. 点卡片外背景收起（兄弟背景层回归）；
 *   5. 「取消」关闭且不发改名 RPC。
 *
 * 前置：npx playwright-core install chromium（脚本自起 vite build+preview 与 mock）。
 * 用法：node scripts/web-rename-smoke.js
 */

const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright-core');

const {startMockGateway} = require('./mock-gateway');

const ROOT = path.join(__dirname, '..');
// 与其他冒烟（9199/5188 … 9205/5193）错开，避免并行会话占口
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 9206);
const VITE_PORT = Number(process.env.SMOKE_VITE_PORT || 5194);
const VIEW = {width: 900, height: 900};
const TITLE = '重命名冒烟会话';
// 键盘逐字输入走 ASCII，避免 CJK 经 CDP insertText 的 IME 不确定性
const NEW_TITLE = 'Renamed-Smoke-01';
const CONN_NAME = '冒烟直连F';

const EXE = chromium.executablePath();
if (!fs.existsSync(EXE)) {
  console.error(`未找到 Chromium：${EXE}`);
  console.error('请先安装：npx playwright-core install chromium');
  process.exit(1);
}

let gw;
let failures = 0;
const pageErrors = [];

function check(ok, label) {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`);
  if (!ok) {
    failures++;
  }
}

/** 统计 session.title 写形式（带 title 参数）调用次数。 */
function titleWriteCalls() {
  return gw.state.calls.filter(
    c => c.method === 'session.title' && typeof c.params?.title === 'string',
  );
}

/** 打开重命名弹窗并等输入框就绪（从 ⋯ 菜单进入）。 */
async function openRenameModal(page) {
  await page.getByText('⋯').click();
  await page.getByText('重命名会话', {exact: true}).click();
  const input = page.getByPlaceholder('输入新的会话标题');
  await input.waitFor({timeout: 5000});
  // 等旧菜单弹层退场动画结束（RNW fade ~250ms）：退场中的全屏蒙层仍在
  // DOM 最上层，会吃掉紧随其后的点击/键盘事件（RNW Modal 行为，非本修复范畴）
  await page.waitForTimeout(700);
  return input;
}

async function main() {
  // ─── 1. mock gateway + vite（上游指向 mock）─────────────────────
  gw = await startMockGateway({port: MOCK_PORT, title: TITLE});
  console.log(`mock gateway: http://127.0.0.1:${gw.port}`);

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
      code === 0
        ? resolve()
        : reject(new Error(`vite build 失败:\n${err.slice(-800)}`)),
    );
  });
  const vite = spawn(
    process.execPath,
    [viteBin, 'preview', '--port', String(VITE_PORT), '--strictPort'],
    {cwd: ROOT, env: viteEnv, stdio: ['ignore', 'pipe', 'pipe']},
  );
  let viteUrl = null;
  vite.stdout.on('data', d => {
    const m = String(d).match(/Local:\s+(http:\/\/[^\s/]+\/)/);
    if (m && !viteUrl) {
      viteUrl = m[1];
    }
  });
  vite.stderr.on('data', d => console.log('[vite]', String(d).slice(0, 200)));

  const browser = await chromium.launch({executablePath: EXE, headless: true});
  let page;
  try {
    const t0 = Date.now();
    while (!viteUrl && Date.now() - t0 < 30000) {
      await new Promise(r => setTimeout(r, 200));
    }
    if (!viteUrl) {
      throw new Error('vite 启动超时（未解析到 Local URL）');
    }
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(viteUrl);
        if (r.ok) {
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    console.log(`vite 就绪: ${viteUrl}（上游 → mock ${MOCK_PORT}）`);

    // ─── 2. 浏览器：隔离配置 → 直连 → 进种子会话 ─────────────────
    page = await browser.newPage({viewport: VIEW});
    page.on('pageerror', e => {
      pageErrors.push(String(e));
      console.log('[pageerror]', String(e).slice(0, 300));
    });

    await page.goto(viteUrl, {waitUntil: 'domcontentloaded'});
    await page.waitForTimeout(1500);
    await page.evaluate(() => localStorage.clear());
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForTimeout(1200);

    await page.getByText('＋ 添加配置').click();
    await page.getByText('连接类型').waitFor({timeout: 5000});
    await page.getByText('直连', {exact: true}).click();
    await page.getByPlaceholder('例如：本机 gateway').fill(CONN_NAME);
    await page.getByText('保存', {exact: true}).click();
    await page.getByText(CONN_NAME, {exact: true}).waitFor({timeout: 5000});

    await page.getByText(CONN_NAME, {exact: true}).first().click();
    await page
      .locator('[aria-label^="打开 profile"]')
      .first()
      .waitFor({timeout: 20000});
    await page.waitForTimeout(600);
    await page.locator('[aria-label^="打开 profile"]').first().click();
    await page.getByText(TITLE, {exact: true}).first().waitFor({timeout: 10000});
    await page.getByText(TITLE, {exact: true}).first().click();
    await page.getByPlaceholder('发消息…').waitFor({timeout: 15000});

    // ─── 3. 打开重命名弹窗：预填当前标题 ──────────────────────────
    const input = await openRenameModal(page);
    check(
      (await input.inputValue()) === TITLE,
      `输入框预填当前标题（实际 "${await input.inputValue()}"）`,
    );

    // ─── 4. 【核心回归】真实鼠标点击输入框：弹窗不得关闭、可直接编辑 ──
    // 修复前点击会冒泡到背景层 onPress 直接关弹窗；此处用真实鼠标点击 +
    // 键盘逐字输入验证「点得开、改得了」。activeElement 探针不可靠——
    // RNW Modal 自带 focus trap，弹层打开时 DOM 焦点先落在陷阱容器
    // （click 后焦点正常落到输入框，RNW 内部行为，与本修复无关）。
    await input.click();
    await page.waitForTimeout(400);
    check(
      await page.getByPlaceholder('输入新的会话标题').isVisible(),
      '点击输入框后弹窗仍开（修复前此处必关）',
    );
    await page.keyboard.type(NEW_TITLE);
    await page.waitForTimeout(300);
    check(
      (await input.inputValue()) === NEW_TITLE,
      `点击输入框后键盘可直接改标题（实际 "${await input.inputValue()}"）`,
    );

    // ─── 5. 提交：弹窗关闭 + session.title 写形式 + 头部刷新 ───────
    await page.getByText('重命名', {exact: true}).click();
    await page
      .getByPlaceholder('输入新的会话标题')
      .waitFor({state: 'detached', timeout: 5000})
      .then(() => check(true, '提交后弹窗关闭'))
      .catch(() => check(false, '提交后弹窗关闭'));
    const writes = titleWriteCalls();
    check(
      writes.length === 1 && writes[0].params.title === NEW_TITLE,
      `session.title 写形式恰好 1 次且标题正确（实际 ${writes.length} 次${
        writes[0] ? ` "${writes[0].params.title}"` : ''
      }）`,
    );
    await page.waitForTimeout(600);
    check(
      await page.getByText(NEW_TITLE, {exact: true}).first().isVisible(),
      '新标题即时刷新（头部/列表可见）',
    );

    // ─── 6. 点卡片外背景收起（兄弟背景层回归）─────────────────────
    await openRenameModal(page);
    await page.mouse.click(30, 30);
    await page
      .getByPlaceholder('输入新的会话标题')
      .waitFor({state: 'detached', timeout: 5000})
      .then(() => check(true, '点卡片外背景弹窗收起'))
      .catch(() => check(false, '点卡片外背景弹窗收起'));

    // ─── 7. 「取消」关闭且不改名 ─────────────────────────────────
    await openRenameModal(page);
    await page.getByText('取消', {exact: true}).click();
    await page
      .getByPlaceholder('输入新的会话标题')
      .waitFor({state: 'detached', timeout: 5000})
      .then(() => check(true, '取消后弹窗关闭'))
      .catch(() => check(false, '取消后弹窗关闭'));
    check(
      titleWriteCalls().length === 1,
      `取消未触发改名 RPC（累计 ${titleWriteCalls().length} 次）`,
    );

    check(pageErrors.length === 0, `无 pageerror（实际 ${pageErrors.length}）`);
  } finally {
    if (page) {
      await page.context().close();
    }
    await browser.close();
    vite.kill('SIGTERM');
    if (gw) {
      await gw.close();
    }
  }

  console.log(
    failures === 0 ? '\n冒烟通过 ✓' : `\n冒烟失败 ${failures} 项`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
