/**
 * web-session-search-smoke.js — 会话列表搜索冒烟（Playwright 真实浏览器操作）。
 *
 * 全程不打真实 gateway：本地 mock-gateway（单会话），vite 上游经
 * HERMES_VITE_UPSTREAM 指向 mock。
 *
 * 场景（工具栏「搜索」按钮 → 可关闭搜索栏 → 标题/摘要过滤）：
 *   0. 列表工具行点「搜索」→ 搜索栏出现；
 *   1. 输入命中词：会话行保留；
 *   2. 输入不存在的词：行被过滤，空态「未找到匹配的会话」；
 *   3. 互斥：搜索开着点筛选下拉 → 下拉菜单开、搜索栏收起；再点「搜索」
 *      → 菜单收起、搜索栏展开；
 *   4. ✕ 关闭：搜索栏收起、列表恢复全量。
 *
 * 前置：npx playwright-core install chromium（脚本自起 vite build+preview 与 mock）。
 * 用法：node scripts/web-session-search-smoke.js
 */

const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright-core');

const {startMockGateway} = require('./mock-gateway');

const ROOT = path.join(__dirname, '..');
const OUT = 'docs/screenshots';
// 与其他冒烟（9199/5188、聊天搜索 9201/5189）错开，避免并行会话占口
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 9202);
const VITE_PORT = Number(process.env.SMOKE_VITE_PORT || 5190);
const VIEW_H = 900;
const SESSION_TITLE = '列表搜索冒烟会话';

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
  });
  console.log(`mock gateway: http://127.0.0.1:${gw.port}`);

  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const viteEnv = {
    ...process.env,
    HERMES_VITE_UPSTREAM: `http://127.0.0.1:${MOCK_PORT}`,
  };
  await new Promise((resolve, reject) => {
    const build = spawn(
      process.execPath,
      [viteBin, 'build'],
      {cwd: ROOT, env: viteEnv, stdio: ['ignore', 'ignore', 'pipe']},
    );
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

    // ─── 浏览器：隔离配置 → 添加直连 → 连接 → 进会话列表 ─────────
    page = await browser.newPage({viewport: {width: 900, height: VIEW_H}});
    page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
    await page.goto(viteUrl, {waitUntil: 'domcontentloaded'});
    await page.waitForTimeout(1500);
    await page.evaluate(() => localStorage.clear());
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForTimeout(1200);

    await page.getByText('＋ 添加配置').click();
    await page.getByText('连接类型').waitFor({timeout: 5000});
    await page.getByText('直连', {exact: true}).click();
    await page.getByPlaceholder('例如：本机 gateway').fill('冒烟直连B');
    await page.getByText('保存', {exact: true}).click();
    await page.getByText('冒烟直连B').waitFor({timeout: 5000});
    await page.getByText('冒烟直连B').click();
    await page.waitForSelector('[aria-label^="打开 profile"]', {timeout: 20000});
    await page.waitForTimeout(1000);
    await page.locator('[aria-label^="打开 profile"]').first().click();
    // 会话列表页（被测页面）
    const row = page.getByText(SESSION_TITLE).first();
    await row.waitFor({timeout: 10000});
    const input = page.getByPlaceholder('搜索会话标题 / 摘要');
    const eventually = async (fn, timeoutMs, label) => {
      const start = Date.now();
      let last = null;
      while (Date.now() - start < timeoutMs) {
        try {
          last = await fn();
          if (last) {
            return last;
          }
        } catch (e) {
          last = e;
        }
        await page.waitForTimeout(200);
      }
      throw new Error(`等待超时: ${label}（last=${last}）`);
    };

    // ─── 场景 0：点「搜索」→ 搜索栏出现 ──────────────────────────
    await page.getByText('搜索', {exact: true}).click();
    await input.waitFor({timeout: 5000});
    await page.screenshot({path: `${OUT}/web-session-search-1-open.png`});
    console.log('OK 搜索入口：工具行「搜索」按钮展开搜索栏');

    // ─── 场景 1：命中词保留行 ────────────────────────────────────
    await input.fill('冒烟');
    await row.waitFor({timeout: 5000});
    console.log('OK 命中过滤：关键词命中标题，会话行保留');

    // ─── 场景 2：无命中 → 行消失 + 空态文案 ──────────────────────
    await input.fill('zzz不存在');
    await eventually(
      async () => (await page.getByText(SESSION_TITLE).count()) === 0,
      5000,
      '无命中词未过滤掉会话行',
    );
    await page.getByText('未找到匹配的会话').waitFor({timeout: 5000});
    await page.screenshot({path: `${OUT}/web-session-search-2-nohit.png`});
    console.log('OK 无命中：会话行被过滤，显示「未找到匹配的会话」');

    // ─── 场景 3：与下拉菜单互斥（双向）───────────────────────────
    // 3a. 搜索开着 → 开筛选菜单 → 搜索栏收起
    await page.getByText('聊天', {exact: true}).click();
    await page.getByText('自动化', {exact: true}).waitFor({timeout: 5000});
    await eventually(
      async () => (await page.getByPlaceholder('搜索会话标题 / 摘要').count()) === 0,
      5000,
      '开菜单后搜索栏未收起',
    );
    console.log('OK 互斥(开菜单收搜索)：下拉菜单展开，搜索栏收起');
    // 3b. 菜单开着点「搜索」：首击落在菜单 backdrop 上（点外收起的既有交互），
    // 菜单收起后第二击才展开搜索栏。backdrop 只盖左侧列表列（900px 视口是
    // 桌面两栏壳），点击坐标须落在列内空白处
    await page.mouse.click(150, 600);
    await eventually(
      async () => (await page.getByText('自动化', {exact: true}).count()) === 0,
      5000,
      '点外未收起下拉菜单',
    );
    await page.getByText('搜索', {exact: true}).click();
    await input.waitFor({timeout: 5000});
    await page.screenshot({path: `${OUT}/web-session-search-3-mutual.png`});
    console.log('OK 互斥(开搜索收菜单)：搜索栏展开，下拉菜单已收起');

    // ─── 场景 4：✕ 关闭 → 列表恢复全量 ───────────────────────────
    await page.getByText('✕', {exact: true}).click();
    await eventually(
      async () => (await page.getByPlaceholder('搜索会话标题 / 摘要').count()) === 0,
      5000,
      '搜索栏未关闭',
    );
    await row.waitFor({timeout: 5000});
    console.log('OK 关闭：搜索栏收起，列表恢复全量');

    await browser.close();
    page = null;
    console.log('PASS 会话列表搜索冒烟全部通过');
  } catch (e) {
    if (page) {
      await page
        .screenshot({path: `${OUT}/web-session-search-fail.png`})
        .catch(() => {});
    }
    throw e;
  } finally {
    await browser.close().catch(() => {});
    vite.kill();
    await gw.close();
  }
}

main().catch(e => {
  console.error('FAIL', e);
  process.exit(1);
});
