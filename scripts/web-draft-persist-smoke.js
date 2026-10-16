/**
 * web-draft-persist-smoke.js — 输入框草稿跨「应用退出 + 会话换 live sid」回归冒烟。
 *
 * 被测行为（2026-10-17 修订 D060 的 key 口径）：
 *   1. 输入框草稿按「会话跨重启身份」（profile + 持久化会话 id）存，而不是
 *      live sid；
 *   2. App 退出（reload）期间网关把空闲会话回收（ws_orphan_reap）→ 重进会话时
 *      `session.resume` 冷路径返回**新的** live sid：草稿仍必须读回来
 *      （旧实现按 live sid 存，这时读的是另一个 key，草稿等于丢了）；
 *   3. 恢复后照常可发送，发完草稿清空。
 *
 * 前置：npx playwright-core install chromium（脚本自起 vite build+preview 与 mock）。
 * 用法：node scripts/web-draft-persist-smoke.js
 */

const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright-core');

const {startMockGateway} = require('./mock-gateway');

const ROOT = path.join(__dirname, '..');
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 9223);
const VITE_PORT = Number(process.env.SMOKE_VITE_PORT || 5199);
const VIEW = {width: 900, height: 900};
const TITLE = '草稿冒烟';
const CONN_NAME = '冒烟直连D';
const DRAFT = '还没发出去的话（草稿冒烟）';

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
      return true;
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`超时：${label}`);
    }
    await new Promise(r => setTimeout(r, 150));
  }
}

async function main() {
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

    page = await browser.newPage({viewport: VIEW});
    page.on('pageerror', e => {
      pageErrors.push(String(e));
      console.log('[pageerror]', String(e).slice(0, 300));
    });

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
    const inputValue = () => page.getByPlaceholder('发消息…').inputValue();

    // ─── 1. 隔离配置 → 直连 → 进会话 ───────────────────────────────
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

    const liveSidBefore = gw.state.seededLiveSid;
    check(
      String(liveSidBefore).length > 0,
      `已进入会话（live sid=${liveSidBefore}）`,
    );

    // ─── 2. 输入草稿（不发送）→ 应用退出 → 网关回收会话 ───────────
    await page.getByPlaceholder('发消息…').fill(DRAFT);
    check((await inputValue()) === DRAFT, '草稿已输入');
    // 草稿是防抖 300ms 落盘（drafts store 与 AppState flush），此处轮询等落盘
    const readDrafts = () =>
      page.evaluate(() => localStorage.getItem('hermes.drafts.v1') ?? '');
    await eventually(
      async () => (await readDrafts()).includes(DRAFT),
      5000,
      '草稿未落 localStorage（hermes.drafts.v1）',
    );
    check(true, '草稿已落 localStorage（hermes.drafts.v1）');
    // 关键：key 里带的是持久化会话 id（不是 live sid）——live sid 会被网关换掉
    const persisted = await readDrafts();
    check(
      !persisted.includes(`"${liveSidBefore}"`),
      `草稿 key 不含 live sid（${liveSidBefore}）`,
    );

    // 模拟「App 已退出、网关把空闲会话回收」：不广播，只让下次 resume 走冷路径
    const reaped = gw.reapLiveSession(liveSidBefore, 'ws_orphan_reap', {
      broadcast: false,
    });
    check(reaped === true, 'mock：会话已回收（下次 resume 返回新 live sid）');

    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForTimeout(1500);

    // ─── 3. 重进会话：resume 冷路径换新 live sid，草稿必须还在 ─────
    await enterSession();
    const liveSidAfter = gw.state.seededLiveSid;
    check(
      liveSidAfter !== liveSidBefore,
      `重进拿到新的 live sid（${liveSidBefore} → ${liveSidAfter}）`,
    );
    await eventually(
      async () => (await inputValue()) === DRAFT,
      10000,
      `重进后草稿丢失（输入框内容「${await inputValue()}」）`,
    );
    check(true, '重进（换 live sid）后草稿仍在输入框里');

    // ─── 4. 恢复后照常发送，发完草稿清空 ──────────────────────────
    await page.getByText('发送', {exact: true}).click();
    await eventually(
      async () => (await inputValue()) === '',
      8000,
      '发送后草稿未清空',
    );
    const submits = gw.state.calls.filter(c => c.method === 'prompt.submit');
    check(
      submits.length === 1 && submits[0].params?.text === DRAFT,
      `草稿以普通消息发出（submit ${submits.length} 次）`,
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

  console.log(failures === 0 ? '\n冒烟通过 ✓' : `\n冒烟失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
