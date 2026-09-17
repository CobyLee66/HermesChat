/**
 * web-shot-readme.js — README 配图截图脚本（Playwright 手机视口 + mock demo）。
 *
 * 产出入库目录 docs/images/（区别于 gitignored 的 docs/screenshots/——后者
 * 是冒烟脚本含真实数据的临时产物）。按 AGENTS.md 政策，入库配图一律用
 * mock-gateway 的 demo 假数据重拍，画面里没有任何真实会话/主机信息，无需
 * 打码。两份 README（en/zh-CN）共用这一套图。
 *
 * 流程：mock gateway（demo 模式，全英文假数据）→ vite build + preview（上游
 * 指向 mock）→ Chromium 390×844 @2x 手机视口（web 连接就绪后自动进
 * DesktopApp 单列手机形态，panels 与原生手机同源）→ localStorage 预置英文
 * UI + 两张 SSH 假连接卡 → 逐场景真实 UI 操作并截图：
 *   1. 连接首页（假卡占位 192.168.1.x）  2. Profile 列表
 *   3. 定时任务列表                      4. 会话列表
 *   5. 聊天 hero（富历史 + 现场流式回包：思考块/工具卡/Markdown）
 *   6. clarify 澄清卡                     7. 模型选择器
 *
 * 前置：npx playwright-core install chromium（脚本自起 mock 与 vite）。
 * 用法：node scripts/web-shot-readme.js
 */

const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright-core');

const {startMockGateway} = require('./mock-gateway');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'images');
// 与既有冒烟（9199/5188、9201/5189、9202/5190、9203/5191）错开端口
// （9210 曾被本机其他应用占用，避开）
const MOCK_PORT = Number(process.env.SHOOT_MOCK_PORT || 9212);
const VITE_PORT = Number(process.env.SHOOT_VITE_PORT || 5195);
const VIEW_W = 390;
const VIEW_H = 844;
const HERO_TITLE = 'Release checklist review';
const HERO_PROMPT =
  'Good catch — also refresh the context usage after a reconnect. ' +
  'Can you fold both fixes into a changelog entry?';
const REPLY_END_MARK = 'moment the tunnel reopens';

/** localStorage 预置：英文 UI + 两张 SSH 假连接卡（全占位值，无真实信息） */
const SEED_LOCAL_STORAGE = {
  'hermes.locale.v1': 'en',
  'hermes.connections.v2': JSON.stringify({
    profiles: [
      {
        id: 'demo-conn-1',
        name: 'Office desktop',
        type: 'ssh',
        host: '192.168.1.10',
        port: '22',
        username: 'me',
        password: '',
        privateKey: '',
        passphrase: '',
        keyFileName: '',
        token: '',
      },
      {
        id: 'demo-conn-2',
        name: 'Home server',
        type: 'ssh',
        host: '192.168.1.20',
        port: '22',
        username: 'me',
        password: '',
        privateKey: '',
        passphrase: '',
        keyFileName: '',
        token: '',
      },
    ],
    currentProfileId: null,
    autoProfileId: null,
  }),
};

const EXE = chromium.executablePath();
if (!EXE || !fs.existsSync(EXE)) {
  console.error(`未找到 Chromium：${EXE}`);
  console.error('请先安装：npx playwright-core install chromium');
  process.exit(1);
}

/** 轮询等待条件成立（页面内容是流式/异步渲染，轮询比固定 sleep 稳） */
async function waitUntil(fn, {timeout = 15000, interval = 250, what = ''} = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) {
      return true;
    }
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`等待超时：${what || fn.name}`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, {recursive: true});
  const gw = await startMockGateway({
    port: MOCK_PORT,
    demo: true,
    title: HERO_TITLE,
    stream: {rich: true, intervalMs: 350},
  });
  console.log(`mock gateway: http://127.0.0.1:${gw.port}（demo 模式）`);

  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const viteEnv = {
    ...process.env,
    HERMES_VITE_UPSTREAM: `http://127.0.0.1:${MOCK_PORT}`,
  };
  // 用「build + preview」而非 dev server：dev 首次进聊天会发现新依赖触发
  // 重新预构建 + 整页 reload（既有冒烟同款结论）
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

  const shot = name => {
    const file = path.join(OUT_DIR, name);
    return page.screenshot({path: file}).then(() => console.log(`📸 ${name}`));
  };

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

    // 手机视口 @2x（截图 780×1688，README 里高清显示）+ 英文 locale
    const context = await browser.newContext({
      viewport: {width: VIEW_W, height: VIEW_H},
      deviceScaleFactor: 2,
      locale: 'en-US',
    });
    await context.addInitScript(items => {
      for (const [k, v] of Object.entries(items)) {
        window.localStorage.setItem(k, v);
      }
    }, SEED_LOCAL_STORAGE);
    page = await context.newPage();
    page.on('console', m => {
      if (m.type() === 'error') {
        console.log('[console.error]', m.text().slice(0, 300));
      }
    });
    page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));

    await page.goto(viteUrl, {waitUntil: 'domcontentloaded'});
    await page.waitForTimeout(1500);

    // ─── 1. 连接首页（预置的假 SSH 卡片）──────────────────────────
    await page.getByText('Office desktop').waitFor({timeout: 10000});
    await page.waitForTimeout(500);
    await shot('readme-connections.png');

    // ─── 2. 浏览器直连 → Profile 列表 ────────────────────────────
    await page
      .getByText('⚡ Direct connect (local 127.0.0.1:9119)')
      .click();
    await page.waitForSelector('[aria-label^="Open profile"]', {timeout: 20000});
    await page.waitForTimeout(1200); // 等 profile 列表/头像拉取
    await shot('readme-profiles.png');

    // ─── 3. 定时任务视图 ──────────────────────────────────────────
    await page.getByText('Cron jobs', {exact: true}).click();
    await page.getByText('Nightly dependency audit').waitFor({timeout: 10000});
    await page.waitForTimeout(500);
    await shot('readme-cron.png');

    // ─── 4. 回会话视图 → 选第一个 profile → 会话列表 ──────────────
    await page.getByText('Sessions', {exact: true}).click();
    await page.waitForSelector('[aria-label^="Open profile"]', {timeout: 10000});
    await page.locator('[aria-label^="Open profile"]').first().click();
    await page.getByText(HERO_TITLE).waitFor({timeout: 10000});
    await page.waitForTimeout(800);
    await shot('readme-sessions.png');

    // ─── 5. 打开 hero 会话 → 现场发问 → 等流式回包完成 ────────────
    await page.getByText(HERO_TITLE, {exact: true}).first().click();
    await page.getByPlaceholder('Message…').waitFor({timeout: 15000});
    await page.waitForTimeout(600);
    // RNW 嵌套 span 会把段落拆成多个文本节点，getByText 的可见性判定不稳，
    // 统一用 bodyText 包含式轮询（既有冒烟同款做法）
    const bodyText = () =>
      page.evaluate(() => document.body.innerText || '');
    /**
     * 恢复贴底：窄视口下流式内容增长可能触发浏览器滚动锚定补偿把视口带离
     * 底部（新 cell 被虚拟化卸载，bodyText 里看不到）——像用户一样点应用
     * 自带的「回到底部」按钮；按钮未出现时直接把 inverted 容器 scrollTop
     * 归零（等价于 App 内部 scrollTo(0)，会触发 onScroll 恢复贴底跟随）。
     */
    const ensureBottom = async () => {
      const jump = page.getByText('↓ Back to bottom');
      if (
        (await jump.count()) > 0 &&
        (await jump.first().isVisible().catch(() => false))
      ) {
        await jump.first().click();
        await page.waitForTimeout(600);
        return;
      }
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('div')) {
          const cs = getComputedStyle(el);
          if ((cs.transform || '').startsWith('matrix(1, 0, 0, -1')) {
            el.scrollTop = 0;
            return true;
          }
        }
        return false;
      });
      await page.waitForTimeout(600);
    };
    await page.getByPlaceholder('Message…').fill(HERO_PROMPT);
    await page.getByText('Send', {exact: true}).click();
    // 先等 mock 侧整轮回包完成（message.complete 已把全文落进历史投影），
    // 再恢复贴底取景，避免在流式中途截图
    await waitUntil(
      async () =>
        gw.state.messages.some(
          m => typeof m.text === 'string' && m.text.includes(REPLY_END_MARK),
        ),
      {timeout: 20000, what: 'mock 回包完成'},
    );
    await ensureBottom();
    try {
      await waitUntil(async () => (await bodyText()).includes(REPLY_END_MARK), {
        timeout: 10000,
        what: `hero 回包渲染 ${REPLY_END_MARK}`,
      });
    } catch (e) {
      // 诊断：mock 调用流水 / delta 计数 / 页面文本
      console.log(
        '[diag] rpc calls:',
        gw.state.calls.map(c => c.method).join(','),
      );
      console.log('[diag] deltaSent:', gw.state.deltaSent);
      const txt = await bodyText();
      console.log('[diag] bodyText length:', txt.length);
      console.log('[diag] bodyText head:', txt.slice(0, 400));
      throw e;
    }
    await page.waitForTimeout(400); // 等布局稳定
    await shot('readme-chat-hero.png');

    // ─── 6. clarify 澄清卡（挂起态）───────────────────────────────
    await page.getByPlaceholder('Message…').fill('CLARIFY');
    await page.getByText('Send', {exact: true}).click();
    // 等 mock 侧挂起（clarify.request 已发）再取景，卡片钉在会话底部
    await waitUntil(async () => gw.state.pendingClarify != null, {
      timeout: 10000,
      what: 'mock clarify 挂起',
    });
    await page.waitForTimeout(800); // 等卡片渲染
    await ensureBottom();
    await waitUntil(
      async () =>
        (await bodyText()).includes('Your answer is needed') &&
        (await bodyText()).includes('CHANGELOG.md'),
      {timeout: 10000, what: 'clarify 卡可见'},
    );
    await page.waitForTimeout(500);
    await shot('readme-clarify.png');

    // ─── 7. ⋯ 菜单 → Switch model → 模型选择器 ───────────────────
    await page.getByText('⋯').first().click();
    await waitUntil(async () => (await bodyText()).includes('Session info'), {
      timeout: 5000,
      what: '⋯ 菜单展开',
    });
    await page.getByText('Switch model').first().click();
    await waitUntil(
      async () =>
        (await bodyText()).includes('Demo Cloud') &&
        (await bodyText()).includes('model-x-mini'),
      {timeout: 10000, what: '模型选择器列表'},
    );
    await page.waitForTimeout(500);
    await shot('readme-model-picker.png');

    await browser.close();
  } finally {
    vite.kill();
    await gw.close().catch(() => {});
  }
  console.log(`DONE（产物目录 ${path.relative(ROOT, OUT_DIR)}/）`);
}

main().catch(e => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
