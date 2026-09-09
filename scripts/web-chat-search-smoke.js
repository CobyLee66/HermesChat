/**
 * web-chat-search-smoke.js — 聊天记录查找冒烟（Playwright 真实浏览器操作）。
 *
 * 全程不打真实 gateway：本地 mock-gateway（historyCount=30，种子历史每条含
 * 「懒挂载」一词作为搜索关键词），vite 上游经 HERMES_VITE_UPSTREAM 指向 mock。
 *
 * 场景（⌘F 式查找闭环）：
 *   0. ⋯ 菜单 → 「查找聊天记录」→ 顶部搜索栏出现；
 *   1. 输入关键词：命中计数 1/30，自动跳到最早一条命中（inverted 列表
 *      scrollTop 大幅前移），命中消息带 accent 描边高亮；
 *   2. ↓：计数 2/30，视口向新消息方向移动；↑：计数回到 1/30；
 *   3. ✕：搜索栏关闭、高亮清除。
 *
 * 前置：npx playwright-core install chromium（脚本自起 vite build+preview 与 mock）。
 * 用法：node scripts/web-chat-search-smoke.js
 */

const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright-core');

const {startMockGateway} = require('./mock-gateway');

const ROOT = path.join(__dirname, '..');
const OUT = 'docs/screenshots';
// 与其他冒烟（9199/5188）错开，避免并行会话占口
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 9201);
const VITE_PORT = Number(process.env.SMOKE_VITE_PORT || 5189);
const HISTORY = 30;
const VIEW_H = 900;
const KEYWORD = '懒挂载';
const ACCENT_RGB = 'rgb(18, 183, 245)'; // Colors.accent #12B7F5

const EXE = chromium.executablePath();
if (!fs.existsSync(EXE)) {
  console.error(`未找到 Chromium：${EXE}`);
  console.error('请先安装：npx playwright-core install chromium');
  process.exit(1);
}

let gw;

async function main() {
  // ─── 1. mock gateway + vite（上游指向 mock）─────────────────────
  gw = await startMockGateway({
    port: MOCK_PORT,
    title: '聊天搜索冒烟',
    historyCount: HISTORY,
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

    // ─── 2. 浏览器：隔离配置 → 添加直连 → 连接 → 进会话 ───────────
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
    await page.getByPlaceholder('例如：本机 gateway').fill('冒烟直连A');
    await page.getByText('保存', {exact: true}).click();
    await page.getByText('冒烟直连A').waitFor({timeout: 5000});
    await page.getByText('冒烟直连A').click();
    await page.waitForSelector('[aria-label^="打开 profile"]', {timeout: 20000});
    await page.waitForTimeout(1000);
    await page.locator('[aria-label^="打开 profile"]').first().click();
    await page.getByText('新会话', {exact: true}).waitFor({timeout: 10000});
    await page.waitForTimeout(800);
    await page.getByText('聊天搜索冒烟').first().click();
    await page.getByPlaceholder('发消息…').waitFor({timeout: 10000});
    await page.waitForTimeout(600);

    // ─── 页内工具 ────────────────────────────────────────────────
    const readScroll = () =>
      page.evaluate(() => {
        let best = null;
        for (const el of document.querySelectorAll('div')) {
          const cs = getComputedStyle(el);
          if (
            (cs.transform || '').startsWith('matrix(1, 0, 0, -1') &&
            (cs.overflowY === 'scroll' || cs.overflowY === 'auto')
          ) {
            if (!best || el.scrollHeight > best.scrollHeight) {
              best = el;
            }
          }
        }
        return best ? Math.round(best.scrollTop) : null;
      });
    /** 当前命中消息的 accent 描边高亮元素数（2px 边框区分 hairline 徽标） */
    const highlightCount = () =>
      page.evaluate(rgb => {
        let n = 0;
        for (const el of document.querySelectorAll('div')) {
          const cs = getComputedStyle(el);
          if (
            cs.borderTopWidth === '2px' &&
            cs.borderTopColor === rgb &&
            cs.borderRightColor === rgb
          ) {
            n++;
          }
        }
        return n;
      }, ACCENT_RGB);
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
    /** 等动画滚动停稳（连续采样差 <5px）后取 scrollTop */
    const settleScroll = async () => {
      let prev = await readScroll();
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(350);
        const cur = await readScroll();
        if (Math.abs(cur - prev) < 5) {
          return cur;
        }
        prev = cur;
      }
      return prev;
    };

    // ─── 3. 场景 0：⋯ 菜单打开搜索栏 ─────────────────────────────
    await page.getByText('⋯', {exact: true}).click();
    await page.getByText('查找聊天记录', {exact: true}).waitFor({timeout: 5000});
    await page.screenshot({path: `${OUT}/web-chat-search-0-menu.png`});
    await page.getByText('查找聊天记录', {exact: true}).click();
    const input = page.getByPlaceholder('查找聊天记录');
    await input.waitFor({timeout: 5000});
    console.log('OK 菜单入口：顶部搜索栏已打开');

    // ─── 4. 输入关键词：计数 + 自动跳第一处 + 高亮 ────────────────
    // 进会话时贴底
    const before = await readScroll();
    if (before !== 0) {
      throw new Error(`进会话未贴底：scrollTop=${before}`);
    }
    await input.fill(KEYWORD);
    // 30 条种子历史都含关键词 → 计数 1/30
    await page.getByText(`1/${HISTORY}`, {exact: true}).waitFor({timeout: 5000});
    // 自动跳到最早命中（历史第 1 条，inverted 列表深处）
    const afterFirst = await settleScroll();
    if (!(afterFirst > 300)) {
      throw new Error(`输入后未滚动到首个命中：scrollTop=${afterFirst}`);
    }
    await eventually(async () => (await highlightCount()) === 1, 5000, '未见命中高亮');
    await page.screenshot({path: `${OUT}/web-chat-search-1-first-hit.png`});
    console.log(`OK 输入关键词：计数 1/${HISTORY}，自动跳到最早命中（scrollTop=${afterFirst}），命中消息高亮`);

    // ─── 5. ↓ 下一个 / ↑ 上一个 ──────────────────────────────────
    // 最早几条命中都贴内容顶部（居中定位被 maxScroll clamp 且条目密集），
    // 连跳 10 处到中段拉大位移差再断言
    for (let k = 2; k <= 11; k++) {
      await page.getByText('↓', {exact: true}).click();
      await page.getByText(`${k}/${HISTORY}`, {exact: true}).waitFor({timeout: 5000});
    }
    const afterNext = await settleScroll();
    if (afterNext > afterFirst - 300) {
      throw new Error(
        `↓ 未向新消息方向移动：scrollTop=${afterNext}（首跳=${afterFirst}）`,
      );
    }
    await page.screenshot({path: `${OUT}/web-chat-search-2-next.png`});
    console.log(`OK 下一个：计数 11/${HISTORY}，视口向新消息方向移动（${afterFirst} → ${afterNext}）`);

    for (let k = 10; k >= 1; k--) {
      await page.getByText('↑', {exact: true}).click();
      await page.getByText(`${k}/${HISTORY}`, {exact: true}).waitFor({timeout: 5000});
    }
    const afterPrev = await settleScroll();
    if (Math.abs(afterPrev - afterFirst) > 200) {
      throw new Error(
        `↑ 未回到首个命中：scrollTop=${afterPrev}（首跳=${afterFirst}）`,
      );
    }
    console.log(`OK 上一个：计数回到 1/${HISTORY}，视口回到首个命中（${afterPrev}）`);

    // ─── 6. ✕ 关闭：搜索栏消失 + 高亮清除 ────────────────────────
    await page.getByText('✕', {exact: true}).click();
    await eventually(
      async () => (await page.getByPlaceholder('查找聊天记录').count()) === 0,
      5000,
      '搜索栏未关闭',
    );
    await eventually(async () => (await highlightCount()) === 0, 5000, '高亮未清除');
    await page.screenshot({path: `${OUT}/web-chat-search-3-closed.png`});
    console.log('OK 关闭：搜索栏消失，命中高亮清除');

    await browser.close();
    page = null;
    console.log('PASS 聊天记录查找冒烟全部通过');
  } catch (e) {
    if (page) {
      await page
        .screenshot({path: `${OUT}/web-chat-search-fail.png`})
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
