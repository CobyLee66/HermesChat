/**
 * web-model-picker-smoke.js — 流式期间模型弹窗回归冒烟。
 *
 * 被测行为（修复「流式期间弹窗失灵 + 流式中切模型崩溃」）：
 *   1. 会话 A 流式输出中，回列表新建空会话 B 并进入；
 *   2. B 中打开「切换模型」弹窗：列表须一次加载完成（不等流式结束）；
 *   3. 弹窗打开期间（流式仍在继续）：model.options / config.get(reasoning)
 *      各恰好收到 1 次（修复前每个 delta 重发一对 RPC，此处会飙到几十）；
 *   4. 流式中点选模型：config.set(model) 发出一次、弹窗关闭、页面无异常。
 *
 * 前置：npx playwright-core install chromium（脚本自起 vite build+preview 与 mock）。
 * 用法：node scripts/web-model-picker-smoke.js
 */

const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright-core');

const {startMockGateway} = require('./mock-gateway');

const ROOT = path.join(__dirname, '..');
// 与其他冒烟（9199/5188 … 9204/5192）错开，避免并行会话占口
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 9205);
const VITE_PORT = Number(process.env.SMOKE_VITE_PORT || 5193);
const VIEW = {width: 900, height: 900};
const TITLE = '模型弹窗冒烟';
const CONN_NAME = '冒烟直连E';
/** 流式窗口：30 × 400ms ≈ 12s，足够覆盖「发消息 → 回列表 → 新建 → 开弹窗」 */
const STREAM = {chunks: 30, intervalMs: 400};

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

    // ─── 2. 浏览器：隔离配置 → 直连 → 进种子会话 A ────────────────
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

    // ─── 3. 会话 A 发起流式（30 chunks × 400ms ≈ 12s 窗口）─────────
    await page.getByPlaceholder('发消息…').fill('开始输出');
    await page.getByText('发送', {exact: true}).click();
    // 首段 delta 即到；等一拍确保流式确实进行中
    await page.waitForTimeout(1200);
    const callsBeforePicker = gw.state.calls.length;

    // ─── 4. 新建空会话 B（web 宽视口为双栏：左列表右聊天，无需返回）──────
    await page.getByText('新会话', {exact: true}).waitFor({timeout: 8000});
    await page.getByText('新会话', {exact: true}).click();
    await page.getByPlaceholder('发消息…').waitFor({timeout: 8000});

    await page.getByText('⋯').click();
    await page.getByText('切换模型', {exact: true}).first().click();

    // 列表须在流式进行中一次加载出来（修复前卡在 spinner/超时）
    await page.getByText('Mock Provider').waitFor({timeout: 8000});
    check(true, '流式中弹窗列表加载完成（Mock Provider 可见）');
    check(
      await page.getByText('mock-model-pro', {exact: true}).isVisible(),
      '模型行 mock-model-pro 可见',
    );

    // 弹窗保持打开 ~2.5s（流式仍在继续），统计期间的 RPC 次数
    await page.waitForTimeout(2500);
    const pickerCalls = gw.state.calls.slice(callsBeforePicker);
    const modelOptionsCalls = pickerCalls.filter(c => c.method === 'model.options');
    const modelOptionsCount = modelOptionsCalls.length;
    const reasoningGetCount = pickerCalls.filter(
      c => c.method === 'config.get' && c.params?.key === 'reasoning',
    ).length;
    // 弹窗开在新建会话 B 上：model.options 的 session_id 应是新建的 liveN*
    // 而非种子会话 A 的 live0001（证明「新会话 + 他人流式」场景真实命中）
    check(
      String(modelOptionsCalls[0]?.params?.session_id ?? '').startsWith('liveN'),
      `弹窗 RPC 指向新会话 B（session_id=${modelOptionsCalls[0]?.params?.session_id}）`,
    );
    check(
      modelOptionsCount === 1,
      `弹窗打开期间 model.options 恰好 1 次（实际 ${modelOptionsCount}）`,
    );
    check(
      reasoningGetCount === 1,
      `弹窗打开期间 config.get(reasoning) 恰好 1 次（实际 ${reasoningGetCount}）`,
    );

    // ─── 5. 流式中点选模型：config.set(model) 一次 + 弹窗关闭 + 页面无恙
    await page.getByText('mock-model-pro', {exact: true}).click();
    await page.waitForTimeout(800);
    const modelSets = gw.state.calls.filter(
      c => c.method === 'config.set' && c.params?.key === 'model',
    );
    check(
      modelSets.length === 1 &&
        String(modelSets[0].params?.value ?? '').includes('mock-model-pro'),
      `流式中切模型 config.set(model) 一次（实际 ${modelSets.length}）`,
    );
    check(
      (await page.getByText('Mock Provider').count()) === 0,
      '点选后弹窗关闭',
    );
    await page.getByPlaceholder('发消息…').waitFor({timeout: 5000});
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
