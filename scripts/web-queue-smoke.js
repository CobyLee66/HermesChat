/**
 * web-queue-smoke.js — AI 输出中「排队消息」回归冒烟（D064）。
 *
 * 被测行为：
 *   1. 流式输出中输入新内容 → 中断按钮上方出现「排队」按钮，点它排队：
 *      排队条显示消息内容、localStorage 落盘，且**不产生** prompt.submit；
 *   2. 当前流程结束（turn 结束）→ 自动把队首送出，提交带 `queued: true`
 *      （服务端「客户端队列排水」契约），排队条随之清空；
 *   3. 点「中断」→ 队首同样自动送出（force 路径）；
 *   4. 应用退出（reload）→ 重进会话后排队内容仍在（按 profile + 持久化
 *      会话 id 存，不随 live sid 变化丢失）并自动补发。
 *
 * 前置：npx playwright-core install chromium（脚本自起 vite build+preview 与 mock）。
 * 用法：node scripts/web-queue-smoke.js
 */

const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright-core');

const {startMockGateway} = require('./mock-gateway');

const ROOT = path.join(__dirname, '..');
// 与其他冒烟错开端口（5187~5197 / 9196~9221 已占用）
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 9222);
const VITE_PORT = Number(process.env.SMOKE_VITE_PORT || 5198);
const VIEW = {width: 900, height: 900};
const TITLE = '排队冒烟';
const CONN_NAME = '冒烟直连Q';
/** 流式窗口：8 × 500ms + 150ms ≈ 4.2s（够完成排队/中断动作，又不拖慢冒烟） */
const STREAM = {chunks: 8, intervalMs: 500};
const QUEUE_STORE_KEY = 'hermes.queuedPrompts.v1';

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

async function eventually(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) {
      return;
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`超时：${label}`);
    }
    await new Promise(r => setTimeout(r, 150));
  }
}

/** 排队条内容（无条时返回空串） */
async function stripText(page) {
  const strip = page.locator('[data-testid="queued-strip"]');
  if ((await strip.count()) === 0) {
    return '';
  }
  return (await strip.first().innerText()).replace(/\s+/g, ' ').trim();
}

async function submits() {
  return gw.state.calls.filter(c => c.method === 'prompt.submit');
}

async function main() {
  // ─── 1. mock gateway + vite（上游指向 mock）─────────────────────
  gw = await startMockGateway({port: MOCK_PORT, title: TITLE, stream: STREAM});
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

    page = await browser.newPage({viewport: VIEW});
    page.on('pageerror', e => {
      pageErrors.push(String(e));
      console.log('[pageerror]', String(e).slice(0, 300));
    });

    /** 连接 + 进入种子会话（reload 后复用同一路径） */
    const enterSession = async () => {
      await page.getByText(CONN_NAME, {exact: true}).first().click();
      await page
        .locator('[aria-label^="打开 profile"]')
        .first()
        .waitFor({timeout: 20000});
      await page.waitForTimeout(500);
      await page.locator('[aria-label^="打开 profile"]').first().click();
      await page.getByText(TITLE, {exact: true}).first().waitFor({timeout: 10000});
      await page.getByText(TITLE, {exact: true}).first().click();
      await page.getByPlaceholder('发消息…').waitFor({timeout: 15000});
    };

    // ─── 2. 隔离配置 → 直连 → 进会话 ───────────────────────────────
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
    await enterSession();

    // ─── 3. 发起流式（≈4.2s 窗口），流式中排队 ─────────────────────
    await page.getByPlaceholder('发消息…').fill('开始输出');
    await page.getByText('发送', {exact: true}).click();
    await page.waitForTimeout(1200);
    const submitBase = (await submits()).length; // 1
    check(submitBase === 1, `首条消息已提交（prompt.submit ${submitBase} 次）`);

    await page.getByPlaceholder('发消息…').fill('排队第一条');
    const queueBtn = page.getByText('排队', {exact: true});
    await queueBtn.waitFor({timeout: 5000});
    check(true, '流式中出现「排队」按钮（中断按钮列）');
    // 排队按钮在中断按钮上方：同一列的纵向布局
    const stacked = await page.evaluate(() => {
      const q = [...document.querySelectorAll('div')].find(
        el => el.textContent === '排队' && el.parentElement,
      );
      const i = [...document.querySelectorAll('div')].find(
        el => el.textContent === '中断' && el.parentElement,
      );
      if (!q || !i || q.parentElement !== i.parentElement) {
        return null;
      }
      const col = q.parentElement;
      const qr = q.getBoundingClientRect();
      const ir = i.getBoundingClientRect();
      return {
        direction: getComputedStyle(col).flexDirection,
        above: qr.bottom <= ir.top + 1,
        overlap: qr.right > i.left && qr.left < i.right,
      };
    });
    check(
      stacked !== null && stacked.direction === 'column' && stacked.above,
      `排队按钮在中断按钮上方且同列（${JSON.stringify(stacked)}）`,
    );

    await queueBtn.click();
    await page.waitForTimeout(300);
    const strip1 = await stripText(page);
    check(
      strip1.includes('排队中') && strip1.includes('排队第一条'),
      `排队条显示未发送内容（实际「${strip1}」）`,
    );
    check(
      (await submits()).length === submitBase,
      `排队不产生提交（prompt.submit 仍 ${submitBase} 次）`,
    );
    const persisted = await page.evaluate(
      k => localStorage.getItem(k) ?? '',
      QUEUE_STORE_KEY,
    );
    check(
      persisted.includes('排队第一条'),
      '排队内容已落 localStorage（hermes.queuedPrompts.v1）',
    );

    // ─── 4. 当前流程结束后自动发送（带 queued:true）─────────────────
    await eventually(
      async () => (await stripText(page)) === '',
      15000,
      '流式结束后排队条未清空',
    );
    const afterTurn = await submits();
    const auto = afterTurn[afterTurn.length - 1];
    check(
      afterTurn.length === submitBase + 1 &&
        auto?.params?.text === '排队第一条' &&
        auto?.params?.queued === true,
      `流程结束后自动发送队首（queued=${auto?.params?.queued}，text=${auto?.params?.text}）`,
    );

    // ─── 5. 点中断：队首同样自动送出 ───────────────────────────────
    await page.waitForTimeout(800); // 让新 turn 的流式起来
    await page.getByPlaceholder('发消息…').fill('排队第二条');
    await page.getByText('排队', {exact: true}).click();
    await eventually(
      async () => (await stripText(page)).includes('排队第二条'),
      5000,
      '第二条未进入排队条',
    );
    const beforeInterrupt = (await submits()).length;
    await page.locator('text=中断').first().click();
    await eventually(
      async () => (await submits()).length === beforeInterrupt + 1,
      8000,
      '中断后队首未补发',
    );
    const forced = (await submits())[beforeInterrupt];
    check(
      forced?.params?.text === '排队第二条' && forced?.params?.queued === true,
      `中断后自动发送队首（queued=${forced?.params?.queued}）`,
    );

    // ─── 6. 应用退出（reload）→ 重进会话：排队内容不丢且自动补发 ────
    await page.waitForTimeout(600);
    await page.getByPlaceholder('发消息…').fill('排队第三条');
    await page.getByText('排队', {exact: true}).click();
    await eventually(
      async () => (await stripText(page)).includes('排队第三条'),
      5000,
      '第三条未进入排队条',
    );

    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForTimeout(1500);
    await enterSession();
    await eventually(
      async () => {
        const list = await submits();
        return list.some(c => c.params?.text === '排队第三条');
      },
      15000,
      '重进会话后排队内容未补发（疑似 key 丢失）',
    );
    const restored = (await submits()).find(
      c => c.params?.text === '排队第三条',
    );
    check(
      restored?.params?.queued === true,
      `重进后补发带 queued:true（queued=${restored?.params?.queued}）`,
    );
    check(
      !(await stripText(page)).includes('排队第三条'),
      '补发后排队条清空',
    );

    check(
      pageErrors.length === 0,
      `无 pageerror（实际 ${pageErrors.length}: ${pageErrors.join(' | ').slice(0, 200)}）`,
    );
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

  console.log(failures === 0 ? '\n冒烟通过 ✓' : `\n冒烟失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
