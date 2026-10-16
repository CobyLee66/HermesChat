/**
 * web-process-notification-smoke.js — 后台进程通知归属修复（时间线系统灰条）端到端冒烟。
 *
 * 背景（修复的 bug）：服务端 `tools/process_registry.py format_process_notification`
 * 产出的 `[IMPORTANT: Background process …]` 通知由 tui_gateway 的 notification
 * poller 当**普通 prompt** 提交（不传 display_kind，只有委派通知打标），落库行是
 * `role=user`、无 display_kind；客户端分类器只认 display_kind / `[ASYNC DELEGATION`
 * 前缀 → 该行渲染成用户气泡，看起来像用户自己发的消息。
 * 修复 = utils/processNotification 前缀家族识别 + aggregator 分类器兜底分支 →
 * 灰条（首行原文 + 点击展开 Command/Output 全文）。cron 任务提示词与 skill 注入
 * 同 `[IMPORTANT: ` 信封前缀，必须仍是用户气泡（宽口径反例）。
 *
 * 前置：npx playwright-core install chromium（脚本自起 vite build/preview 与
 * mock gateway，全程不打 live 9119，无写操作）。
 * 用法：node scripts/web-process-notification-smoke.js
 * 端口可用 SMOKE_MOCK_PORT / SMOKE_VITE_PORT 覆盖。
 */

const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright-core');

const {startMockGateway} = require('./mock-gateway');

const ROOT = path.join(__dirname, '..');
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 9221);
const VITE_PORT = Number(process.env.SMOKE_VITE_PORT || 5197);
const SESSION_TITLE = '进程通知冒烟';

/** 服务端 format_process_notification 的完成回执形态（多行，末行以 ] 收尾） */
const NOTIFY_TEXT = [
  '[IMPORTANT: Background process proc_deadbeef1234 completed normally (exit code 0).',
  'Command: npm run build',
  'Output:',
  'build ok',
].join('\n');
const NOTIFY_TEXT_FULL = `${NOTIFY_TEXT}]`;
const NOTIFY_HEADLINE =
  'Background process proc_deadbeef1234 completed normally (exit code 0).';
/** cron 任务提示词：同 `[IMPORTANT: ` 信封前缀，必须保持用户气泡 */
const CRON_PROMPT =
  '[IMPORTANT: You are running as a scheduled cron job. DELIVERY: Your final ' +
  'response will be automatically delivered.';
const PLAIN_USER = '普通用户消息：把构建日志发我';
const BUBBLE_BG = 'rgb(185, 230, 255)'; // components/theme Colors.userBubble
const SYSTEM_BG = 'rgb(236, 237, 242)'; // TimelineView styles.systemBar

const EXE = chromium.executablePath();
if (!fs.existsSync(EXE)) {
  console.error(`未找到 Chromium：${EXE}`);
  console.error('请先安装：npx playwright-core install chromium');
  process.exit(1);
}

/**
 * 页面探针：包含 needle 的**最深**文本元素向上最近的**非透明**背景色。
 * 用户气泡 = Colors.userBubble、系统灰条 = styles.systemBar，两者是唯一
 * 能给消息归属定性的容器底色（断言不依赖 locale / 文案类名）。
 * 副作用：给命中元素打 data-smoke-hit，供 Playwright 定位点击。
 */
const PROBE_FN = needle => {
  const all = Array.from(document.querySelectorAll('div, span'));
  const contains = el => (el.textContent || '').includes(needle);
  const leaf = all.filter(
    el => contains(el) && !Array.from(el.children).some(contains),
  );
  document.querySelectorAll('[data-smoke-hit]').forEach(el => {
    el.removeAttribute('data-smoke-hit');
  });
  if (!leaf.length) {
    return {found: false, bg: null, text: ''};
  }
  const el = leaf[0];
  el.setAttribute('data-smoke-hit', '1');
  let node = el;
  while (node) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
      return {found: true, bg, text: (el.textContent || '').slice(0, 120)};
    }
    node = node.parentElement;
  }
  return {found: true, bg: null, text: (el.textContent || '').slice(0, 120)};
};

let gw;

async function main() {
  gw = await startMockGateway({
    port: MOCK_PORT,
    title: SESSION_TITLE,
    extraHistory: [
      {role: 'user', text: NOTIFY_TEXT_FULL},
      {role: 'user', text: CRON_PROMPT},
      {role: 'user', text: PLAIN_USER},
      {role: 'assistant', text: '收到，这条回执我早前已经消费过了。'},
    ],
  });
  console.log(`>> mock gateway: http://127.0.0.1:${MOCK_PORT}`);

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
      code === 0 ? resolve() : reject(new Error(`vite build 失败:\n${err.slice(-800)}`)),
    );
  });
  const vite = spawn(
    process.execPath,
    [viteBin, 'preview', '--port', String(VITE_PORT), '--strictPort'],
    {cwd: ROOT, env: viteEnv, stdio: ['ignore', 'pipe', 'pipe']},
  );
  const viteUrl = `http://localhost:${VITE_PORT}/`;

  const browser = await chromium.launch({executablePath: EXE, headless: true});
  let page;
  const pageErrors = [];
  try {
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(viteUrl);
        if (r.ok) {
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    console.log(`>> vite 就绪: ${viteUrl}（上游 → mock ${MOCK_PORT}）`);

    page = await (
      await browser.newContext({viewport: {width: 900, height: 900}})
    ).newPage();
    page.on('pageerror', e => pageErrors.push(String(e)));
    // 钉死语言，避免依赖运行机器 locale（与 web-image-viewer-smoke 同款）
    await page.addInitScript(() =>
      localStorage.setItem('hermes.locale.v1', 'zh-CN'),
    );
    await page.goto(viteUrl, {waitUntil: 'domcontentloaded'});
    await page.waitForTimeout(1200);
    await page.getByText('＋ 添加配置').click();
    await page.getByText('连接类型').waitFor({timeout: 5000});
    await page.getByText('直连', {exact: true}).click();
    await page.getByPlaceholder('例如：本机 gateway').fill('通知冒烟-直连');
    await page.getByText('保存', {exact: true}).click();
    await page.getByText('通知冒烟-直连').waitFor({timeout: 5000});
    await page.getByText('通知冒烟-直连').click();
    await page.waitForSelector('[aria-label^="打开 profile"]', {timeout: 20000});
    await page.locator('[aria-label^="打开 profile"]').first().click();
    await page.getByText(SESSION_TITLE, {exact: true}).waitFor({timeout: 10000});
    await page.getByText(SESSION_TITLE, {exact: true}).click();
    await page.waitForTimeout(1500);

    // ---- 1. 通知首行落在系统灰条（不是用户气泡） ----
    const notify = await page.evaluate(PROBE_FN, NOTIFY_HEADLINE);
    if (!notify.found) {
      throw new Error(`时间线里找不到通知首行：${NOTIFY_HEADLINE}`);
    }
    if (notify.bg !== SYSTEM_BG) {
      throw new Error(
        `通知行容器底色异常：${notify.bg}（期望灰条 ${SYSTEM_BG}，用户气泡 ${BUBBLE_BG}）`,
      );
    }
    console.log(`PASS 1: 通知首行渲染在系统灰条（容器底色 ${SYSTEM_BG}）`);

    // ---- 2. 通知全文没有整段渲染（旧行为 = 用户气泡里就是这段原文） ----
    const envelopeShown = await page.evaluate(
      needle => (document.body.textContent || '').includes(needle),
      NOTIFY_TEXT,
    );
    if (envelopeShown) {
      throw new Error('通知原文整段出现在时间线里：仍被当普通用户消息渲染');
    }
    const bubbles = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('div'));
      return all
        .filter(el => {
          const bg = getComputedStyle(el).backgroundColor;
          return bg === 'rgb(185, 230, 255)' && el.textContent;
        })
        .map(el => el.textContent.slice(0, 120));
    });
    if (bubbles.some(text => text.includes('Background process'))) {
      throw new Error(`用户气泡里出现进程通知：${bubbles.join(' | ')}`);
    }
    console.log('PASS 2: 通知原文未作为用户气泡整段渲染（仅灰条首行）');

    // ---- 3. 点击灰条 → 全文层（Command / Output），关闭按钮可收起 ----
    await page.locator('[data-smoke-hit="1"]').click();
    await page.getByText('Command: npm run build').first().waitFor({timeout: 5000});
    const detail = await page.evaluate(() =>
      (document.body.textContent || '').includes('build ok'),
    );
    if (!detail) {
      throw new Error('展开层没有 Output 正文（build ok）');
    }
    await page.getByText('关闭', {exact: true}).last().click();
    await page.waitForTimeout(400);
    const closed = await page.evaluate(
      needle => !(document.body.textContent || '').includes(needle),
      'Command: npm run build',
    );
    if (!closed) {
      throw new Error('展开层关闭按钮无效');
    }
    console.log('PASS 3: 点击灰条展开 Command/Output 全文，关闭按钮收起');

    // ---- 4. 宽口径反例：cron 任务提示词仍是用户气泡 ----
    const cron = await page.evaluate(PROBE_FN, 'You are running as a scheduled cron job');
    if (!cron.found || cron.bg !== BUBBLE_BG) {
      throw new Error(
        `cron 提示词行归属异常：found=${cron.found} bg=${cron.bg}（应仍是用户气泡 ${BUBBLE_BG}）`,
      );
    }
    console.log('PASS 4: cron 任务提示词行仍是用户气泡（未误判为通知）');

    // ---- 5. 普通用户消息不受影响 ----
    const plain = await page.evaluate(PROBE_FN, PLAIN_USER);
    if (!plain.found || plain.bg !== BUBBLE_BG) {
      throw new Error(
        `普通用户消息归属异常：found=${plain.found} bg=${plain.bg}（应为 ${BUBBLE_BG}）`,
      );
    }
    console.log('PASS 5: 普通用户消息仍是用户气泡');

    if (pageErrors.length > 0) {
      throw new Error(`页面异常：${pageErrors.join('\n')}`);
    }
    console.log('web-process-notification-smoke: ALL PASS');
  } finally {
    if (page) {
      await page
        .screenshot({
          path: 'docs/screenshots/web-process-notification-smoke.png',
        })
        .catch(() => {});
    }
    await browser.close();
    vite.kill();
    if (gw) {
      await gw.close();
    }
  }
}

main().catch(e => {
  console.error('FAIL:', e.message || e);
  process.exit(1);
});
