/**
 * web-cron-ui-smoke.js — 定时任务界面交互冒烟（Playwright 真实浏览器操作）。
 *
 * 全程不打真实 gateway：本地 mock-gateway（cron REST + 会话消息只读端点），
 * vite build+preview，直连配置走同源代理。
 *
 * 场景（对应 2026-09-10 五项交互修改 + 09-11 提示词上限修订）：
 *   1. ViewSwitcher 切「定时任务」→ 任务列表渲染（名称/已调度徽章/中文计划）；
 *   2. 点任务行 → 默认打开**编辑**弹层（不再是运行历史）；
 *   3. 提示词输入区默认高 ≈160；填 30 行文本自动撑高但封顶 25 行（≈520px）；拖拽手柄已移除；
 *   4. ⋯ 菜单 → 运行历史 → 列表渲染且内容 720 居中（900 视口 x≈90）；
 *   5. 点运行记录 → 运行详情弹层（元信息 + 对话回放；tool 行与 hidden 行不渲染）；
 *   6. 返回 → 回运行历史列表；再返回 → 回任务列表。
 *
 * 前置：npx playwright-core install chromium（脚本自起 vite build+preview 与 mock）。
 * 用法：node scripts/web-cron-ui-smoke.js
 */

const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright-core');

const {startMockGateway, MOCK_CRON_JOB, MOCK_CRON_MESSAGES} = require('./mock-gateway');

const ROOT = path.join(__dirname, '..');
const OUT = 'docs/screenshots';
// 与其他冒烟（9199/5188、9201/5189、9202/5190）错开，避免并行会话占口
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 9203);
const VITE_PORT = Number(process.env.SMOKE_VITE_PORT || 5191);
const VIEW_W = 900;
const VIEW_H = 900;
const JOB_NAME = MOCK_CRON_JOB.name;
const RUN_TITLE = MOCK_CRON_JOB.name + ' · 09-10';

const EXE = chromium.executablePath();
if (!fs.existsSync(EXE)) {
  console.error(`未找到 Chromium：${EXE}`);
  console.error('请先安装：npx playwright-core install chromium');
  process.exit(1);
}

let gw;

async function main() {
  gw = await startMockGateway({port: MOCK_PORT});
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

    // ─── 浏览器：隔离配置 → 添加直连 → 连接 → profile 首屏 ────────
    page = await browser.newPage({viewport: {width: VIEW_W, height: VIEW_H}});
    const consoleErrors = [];
    page.on('pageerror', e => {
      consoleErrors.push(String(e));
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
    await page.getByPlaceholder('例如：本机 gateway').fill('冒烟直连Cron');
    await page.getByText('保存', {exact: true}).click();
    await page.getByText('冒烟直连Cron').waitFor({timeout: 5000});
    await page.getByText('冒烟直连Cron').click();
    await page.waitForSelector('[aria-label^="打开 profile"]', {timeout: 20000});
    await page.waitForTimeout(800);

    // ─── 场景 1：切「定时任务」视图 → 列表渲染 ────────────────────
    await page.getByText('定时任务', {exact: true}).click();
    const jobRow = page.getByText(JOB_NAME, {exact: true}).first();
    await jobRow.waitFor({timeout: 10000});
    await page.getByText('已调度', {exact: true}).waitFor({timeout: 5000});
    await page.getByText(/每 1 天/).waitFor({timeout: 5000});
    await page.waitForTimeout(500);
    await page.screenshot({path: `${OUT}/web-cron-ui-1-list.png`});
    console.log('OK 场景1：定时任务列表渲染（名称/已调度徽章/中文计划）');

    // ─── 场景 2：点任务行 → 默认打开编辑弹层 ─────────────────────
    await jobRow.click();
    await page.getByText('编辑定时任务').waitFor({timeout: 5000});
    const nameInput = page.locator('input').first();
    const nameVal = await nameInput.inputValue();
    if (nameVal !== JOB_NAME) {
      throw new Error(`编辑弹层名称预填不符：${nameVal}`);
    }
    await page.waitForTimeout(500);
    await page.screenshot({path: `${OUT}/web-cron-ui-2-edit.png`});
    console.log('OK 场景2：点任务行默认打开编辑弹层（名称已预填）');

    // ─── 场景 3：提示词默认 ≈160，填 30 行撑高封顶 25 行；无拖拽手柄 ──
    if ((await page.locator('[aria-label="调整提示词高度"]').count()) !== 0) {
      throw new Error('拖拽手柄应已移除');
    }
    const textarea = page.locator('textarea').first();
    await textarea.scrollIntoViewIfNeeded();
    const boxIdle = await textarea.boundingBox();
    if (!boxIdle || Math.abs(boxIdle.height - 160) > 24) {
      throw new Error(`提示词默认高度异常：${boxIdle?.height}`);
    }
    // 30 行 > 25 行上限：应自动撑高到 520px（行高 20 × 25 + 上下 padding 20）后内部滚动
    const longText = Array.from(
      {length: 30},
      (_, i) => `第${i + 1}行 提示词高度上限冒烟文本`,
    ).join('\n');
    await textarea.fill(longText);
    await page.waitForTimeout(400);
    const boxCapped = await textarea.boundingBox();
    if (!boxCapped || Math.abs(boxCapped.height - 520) > 24) {
      throw new Error(`25 行封顶高度异常：${boxCapped?.height}`);
    }
    await page.waitForTimeout(500);
    await page.screenshot({path: `${OUT}/web-cron-ui-3-maxheight.png`});
    console.log(
      `OK 场景3：提示词默认 ${boxIdle.height} → 30 行封顶 ${boxCapped.height}（25 行上限生效，无拖拽手柄）`,
    );

    await page.getByText('‹ 返回').click();
    await eventually(
      async () => (await page.getByText('编辑定时任务').count()) === 0,
      5000,
      '编辑弹层未关闭',
    );

    // ─── 场景 4：⋯ 菜单 → 运行历史 → 列表居中渲染 ─────────────────
    await page.getByText('⋯', {exact: true}).click();
    await page.getByText('运行历史', {exact: true}).waitFor({timeout: 5000});
    await page.getByText('运行历史', {exact: true}).click();
    await page.getByText(`运行历史 · ${JOB_NAME}`).waitFor({timeout: 5000});
    const runRow = page.getByText(RUN_TITLE).first();
    await runRow.waitFor({timeout: 5000});
    const runBox = await runRow.boundingBox();
    // 900 视口、内容 720 居中 → x ≈ 90
    if (runBox.x < 80) {
      throw new Error(`运行历史未居中：行 x=${runBox.x}`);
    }
    await page.waitForTimeout(500);
    await page.screenshot({path: `${OUT}/web-cron-ui-4-runs.png`});
    console.log(`OK 场景4：运行历史弹层渲染，内容居中（行 x=${runBox.x}）`);

    // ─── 场景 5：点运行记录 → 运行详情（元信息 + 只读对话回放）─────
    await runRow.click();
    await page.getByText('运行详情', {exact: true}).waitFor({timeout: 5000});
    await page.getByText('在聊天中打开').waitFor({timeout: 5000});
    // 任务行预览与详情气泡同文（弹层下方的列表里也有一份），取 DOM 末尾的弹层节点
    await page
      .getByText('整理今天的站会要点并生成摘要')
      .last()
      .waitFor({timeout: 5000});
    await page.getByText(/今日站会要点/).first().waitFor({timeout: 5000});
    const html = await page.content();
    if (html.includes('cat standup.md')) {
      throw new Error('tool 行内容泄漏进运行详情');
    }
    if (html.includes('旧内容，应被隐藏')) {
      throw new Error('display_kind=hidden 行泄漏进运行详情');
    }
    await page.waitForTimeout(500);
    await page.screenshot({path: `${OUT}/web-cron-ui-5-detail.png`});
    console.log('OK 场景5：运行详情弹层（元信息/对话回放渲染，tool 与 hidden 行已过滤）');

    // ─── 场景 6：返回 → 运行历史列表 → 任务列表 ───────────────────
    await page.getByText('‹ 返回').last().click();
    await runRow.waitFor({timeout: 5000});
    console.log('OK 场景6a：详情返回后回到运行历史列表');
    await page.getByText('‹ 返回').last().click();
    await eventually(
      async () => (await page.getByText(`运行历史 · ${JOB_NAME}`).count()) === 0,
      5000,
      '运行历史弹层未关闭',
    );
    await jobRow.waitFor({timeout: 5000});
    console.log('OK 场景6b：运行历史返回后回到任务列表');

    if (consoleErrors.length > 0) {
      throw new Error(`页面 console 错误：${consoleErrors[0].slice(0, 200)}`);
    }

    await browser.close();
    page = null;
    console.log('PASS 定时任务界面冒烟全部通过');
  } finally {
    if (page) {
      await browser.close().catch(() => {});
    }
    vite.kill('SIGTERM');
    await gw.close();
  }
}

main().catch(e => {
  console.error('FAIL', e);
  process.exit(1);
});