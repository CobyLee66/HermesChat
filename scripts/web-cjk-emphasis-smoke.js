/**
 * web-cjk-emphasis-smoke.js — CJK 语境加粗修复（D056）端到端冒烟。
 *
 * 背景：CommonMark flanking 规则下 `是**"重点"**。`（开符前汉字 + 后引号）
 * 加粗不生效；修复 = fixCjkEmphasis 渲染前在失配侧插零宽空格。
 * 本冒烟验证真实 web 渲染管线（vite build/preview + mock-gateway 种子消息）
 * 里该句确实渲染出 <strong>，且代码块/行内代码内的 `**` 不被误修。
 *
 * 全程不打真实 gateway。只读（进 mock 会话看历史，不发送消息）。
 *
 * 用法：node scripts/web-cjk-emphasis-smoke.js
 * 端口冲突换道：SMOKE_MOCK_PORT / SMOKE_VITE_PORT 环境变量。
 */

const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright-core');

const {startMockGateway} = require('./mock-gateway');

const ROOT = path.join(__dirname, '..');
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 9199);
const VITE_PORT = Number(process.env.SMOKE_VITE_PORT || 5189);
const SESSION_TITLE = 'CJK强调冒烟';

/** 覆盖开符/闭符/双侧失配 + 代码豁免 + 已合法不误修 */
const SEED_TEXT = [
  '开符失配：这件事的关键是**"是否值得坚持"**。',
  '',
  '闭符失配：**"重点"**测试一下。',
  '',
  '合法不动：这是**正常加粗**的字。',
  '',
  '行内代码豁免：`是**"别动我"**。`',
  '',
  '```',
  '围栏豁免：是**"也别动"**。',
  '```',
].join('\n');

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
    extraHistory: [{role: 'assistant', text: SEED_TEXT}],
  });
  console.log(`>> mock gateway: http://127.0.0.1:${MOCK_PORT}`);

  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const viteEnv = {...process.env, HERMES_VITE_UPSTREAM: `http://127.0.0.1:${MOCK_PORT}`};
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

    page = await (await browser.newContext({viewport: {width: 900, height: 900}})).newPage();
    page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));

    // 连接（无配置则添加直连配置）→ 进第一个 profile → 进种子会话
    await page.goto(viteUrl, {waitUntil: 'domcontentloaded'});
    await page.waitForTimeout(1500);
    await page.evaluate(() => localStorage.clear());
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForTimeout(1200);
    await page.getByText('＋ 添加配置').click();
    await page.getByText('连接类型').waitFor({timeout: 5000});
    await page.getByText('直连', {exact: true}).click();
    await page.getByPlaceholder('例如：本机 gateway').fill('CJK冒烟-直连');
    await page.getByText('保存', {exact: true}).click();
    await page.getByText('CJK冒烟-直连').waitFor({timeout: 5000});
    await page.getByText('CJK冒烟-直连').click();
    await page.waitForSelector('[aria-label^="打开 profile"]', {timeout: 20000});
    await page.waitForTimeout(1000);
    await page.locator('[aria-label^="打开 profile"]').first().click();
    await page.getByText(SESSION_TITLE, {exact: true}).waitFor({timeout: 10000});
    await page.getByText(SESSION_TITLE, {exact: true}).click();
    await page.waitForSelector('.hm-md', {timeout: 20000});
    await page.waitForTimeout(1000);

    // inverted 时间线：DOM 序与视觉相反，最新消息在 DOM 第一个 .hm-md
    const html = await page.locator('.hm-md').first().innerHTML();

    // ---- 1. 开符失配修复：引号句渲出 strong，且 strong 内含引号 ----
    if (!/<strong>[^<]*"是否值得坚持"[^<]*<\/strong>/.test(html)) {
      throw new Error(`开符失配未修复：${html.slice(0, 200)}`);
    }
    console.log('PASS 1: 是**"是否值得坚持"**。 → <strong> 生效');

    // ---- 2. 闭符失配修复 ----
    if (!/<strong>[^<]*"重点"[^<]*<\/strong>/.test(html)) {
      throw new Error('闭符失配未修复');
    }
    console.log('PASS 2: **"重点"**测试 → <strong> 生效');

    // ---- 3. 合法加粗不受影响 ----
    if (!/<strong>正常加粗<\/strong>/.test(html)) {
      throw new Error('合法加粗被破坏');
    }
    console.log('PASS 3: **正常加粗** 不受影响（无 ZWSP 插入）');

    // ---- 4. 行内代码豁免：code 内 ** 原样保留 ----
    const codeOk = await page.evaluate(() => {
      const codes = [...document.querySelectorAll('.hm-md code')];
      return codes.some(c => c.textContent.includes('**"别动我"**'));
    });
    if (!codeOk) {
      throw new Error('行内代码内的 ** 被误修');
    }
    console.log('PASS 4: 行内代码内 ** 原样保留');

    // ---- 5. 围栏代码豁免 ----
    const fenceOk = await page.evaluate(() => {
      const pres = [...document.querySelectorAll('.hm-md pre')];
      return pres.some(p => p.textContent.includes('**"也别动"**'));
    });
    if (!fenceOk) {
      throw new Error('围栏代码内的 ** 被误修');
    }
    console.log('PASS 5: 围栏代码内 ** 原样保留');

    console.log('web-cjk-emphasis-smoke: ALL PASS');
  } finally {
    if (page) {
      await page.screenshot({path: 'docs/screenshots/web-cjk-emphasis-smoke.png'}).catch(() => {});
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
