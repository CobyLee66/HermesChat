/**
 * web-pending-clarify-smoke.js — 「clarify 挂起期间打开会话」冒烟。
 *
 * 背景（2026-09-11 线上故障）：服务端 `session.resume` 的 `pending_clarify`
 * 是**单个对象**（`_live_session_payload` → `_pending_clarify_request_payload`
 * 返回 `dict | None`），客户端按数组声明直接 `for...of` → Android Hermes 抛
 * 「iterator method is not callable」→ 弹「打开会话失败」；clarify 超时
 * （默认 3600s）后字段消失又能打开（用户实测指纹）。
 *
 * 全程不打真实 gateway：本地 mock-gateway（`pendingClarify` 可运行期切换，
 * 照真实服务端单对象形态），vite 上游经 HERMES_VITE_UPSTREAM 指向 mock。
 *
 * 场景：
 *   0. 单问 clarify 挂起：点会话**打开成功**（无「打开会话失败」弹窗），
 *      澄清卡渲染（标题 + 问题 + 选项）；
 *   1. 点选项「PDF」：mock 收到 clarify.respond{request_id, answer}，
 *      该题显示「已作答」；
 *   2. 批量 clarify 快照（带服务端已锁的 answers）：q0 直接显示「已作答」
 *      （answers 回放），q1 可答 → 点「2」发出带 question_id='q1' 的响应；
 *   3. 无挂起交互（回归）：打开会话正常、无澄清卡、无弹窗。
 *
 * 前置：npx playwright-core install chromium（脚本自起 vite build+preview 与 mock）。
 * 用法：node scripts/web-pending-clarify-smoke.js
 */

const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright-core');

const {startMockGateway} = require('./mock-gateway');

const ROOT = path.join(__dirname, '..');
const OUT = 'docs/screenshots';
// 与其他冒烟（9199/5188、9201/5189、9202/5190）错开，避免并行会话占口
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 9203);
const VITE_PORT = Number(process.env.SMOKE_VITE_PORT || 5191);
const VIEW = {width: 900, height: 900};
const TITLE = '挂起澄清冒烟';
const CONN_NAME = '冒烟直连C';

const SINGLE = {
  request_id: 'cl-single',
  question: '要下载 PDF 还是 HTML 版本？',
  choices: ['PDF', 'HTML'],
};

const BATCH = {
  request_id: 'cl-batch',
  questions: [
    {
      qid: 'q0',
      question: '选哪个口径？',
      choices: ['口径A', '口径B'],
      multi_select: false,
    },
    {qid: 'q1', question: '要几份？', choices: ['1', '2'], multi_select: false},
  ],
  answers: {q0: '口径A'},
};

const EXE = chromium.executablePath();
if (!fs.existsSync(EXE)) {
  console.error(`未找到 Chromium：${EXE}`);
  console.error('请先安装：npx playwright-core install chromium');
  process.exit(1);
}

let gw;
let failures = 0;

function check(ok, label) {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`);
  if (!ok) {
    failures++;
  }
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

    // ─── 2. 浏览器：隔离配置 → 添加直连 → 连接 ────────────────────
    page = await browser.newPage({viewport: VIEW});
    page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
    /** 捕获 window.alert（web 端 alertError 走它）：打开失败会弹「打开会话失败」 */
    const dialogs = [];
    page.on('dialog', async d => {
      dialogs.push(d.message());
      await d.dismiss().catch(() => {});
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

    /** reload 后（配置已持久化）回到会话页：必要时重连 → 选 profile → 点开会话 */
    const enterSession = async () => {
      if (await page.getByText('＋ 添加配置').count()) {
        await page.getByText(CONN_NAME, {exact: true}).first().click();
      }
      await page
        .locator('[aria-label^="打开 profile"]')
        .first()
        .waitFor({timeout: 20000});
      await page.waitForTimeout(600);
      await page.locator('[aria-label^="打开 profile"]').first().click();
      await page.getByText(TITLE, {exact: true}).first().waitFor({timeout: 10000});
      await page.getByText(TITLE, {exact: true}).first().click();
      // 打开成功 = 聊天输入框出现（失败则停在列表并弹 window.alert）
      try {
        await page.getByPlaceholder('发消息…').waitFor({timeout: 15000});
      } catch {
        // 旧实现（单对象当数组 for...of）在此必炸：Alert「打开会话失败」
        throw new Error(
          `打开会话失败：聊天页未出现（window.alert=${JSON.stringify(dialogs)}）`,
        );
      }
      await page.waitForTimeout(500);
    };
    /** 页内 re-enter：reload 到干净状态（自动重连）再进会话 */
    const reopen = async () => {
      await page.reload({waitUntil: 'domcontentloaded'});
      await page.waitForTimeout(1500);
      await enterSession();
    };
    const respondCalls = () =>
      gw.state.calls.filter(c => c.method === 'clarify.respond');
    const cardText = () => page.getByText('💬 需要你的回答').count();

    // ─── 3. 场景 0：单问挂起 → 打开成功 + 澄清卡 ─────────────────
    gw.state.pendingClarify = JSON.parse(JSON.stringify(SINGLE));
    await page.getByText(CONN_NAME, {exact: true}).first().click();
    await page
      .locator('[aria-label^="打开 profile"]')
      .first()
      .waitFor({timeout: 20000});
    await page.waitForTimeout(600);
    await enterSession();
    check(dialogs.length === 0, `场景0 打开会话无弹窗（dialogs=${JSON.stringify(dialogs)}）`);
    check((await cardText()) === 1, '场景0 澄清卡渲染');
    check(
      await page.getByText(SINGLE.question, {exact: true}).isVisible(),
      '场景0 问题文本可见',
    );
    for (const c of SINGLE.choices) {
      check(
        await page.getByText(c, {exact: true}).first().isVisible(),
        `场景0 选项「${c}」可见`,
      );
    }
    await page.screenshot({path: `${OUT}/web-pending-clarify-0-single.png`});

    // ─── 4. 场景 1：点选项作答 → clarify.respond ──────────────────
    await page.getByText('PDF', {exact: true}).first().click();
    const t1 = Date.now();
    while (respondCalls().length === 0 && Date.now() - t1 < 5000) {
      await page.waitForTimeout(200);
    }
    const resp1 = respondCalls()[0];
    check(
      resp1?.params?.request_id === SINGLE.request_id &&
        resp1?.params?.answer === 'PDF' &&
        resp1?.params?.question_id === undefined,
      `场景1 clarify.respond 单问形态（${JSON.stringify(resp1?.params)}）`,
    );
    await page.waitForTimeout(500);
    check(
      await page.getByText('已作答', {exact: true}).first().isVisible(),
      '场景1 该题显示「已作答」',
    );
    await page.screenshot({path: `${OUT}/web-pending-clarify-1-answered.png`});

    // ─── 5. 场景 2：批量挂起（含服务端已锁 answers）───────────────
    gw.state.pendingClarify = JSON.parse(JSON.stringify(BATCH));
    await reopen();
    check(dialogs.length === 0, '场景2 批量快照打开无弹窗');
    check((await cardText()) === 1, '场景2 澄清卡渲染');
    check(
      (await page.getByText('已作答', {exact: true}).count()) === 1,
      '场景2 q0 由 answers 回放为已答（仅 1 条「已作答」）',
    );
    check(
      await page.getByText('要几份？', {exact: true}).isVisible(),
      '场景2 未答的 q1 仍可作答',
    );
    await page.screenshot({path: `${OUT}/web-pending-clarify-2-batch.png`});

    await page.getByText('2', {exact: true}).first().click();
    const t2 = Date.now();
    while (respondCalls().length < 2 && Date.now() - t2 < 5000) {
      await page.waitForTimeout(200);
    }
    const resp2 = respondCalls()[1];
    check(
      resp2?.params?.request_id === BATCH.request_id &&
        resp2?.params?.answer === '2' &&
        resp2?.params?.question_id === 'q1',
      `场景2 clarify.respond 带 question_id（${JSON.stringify(resp2?.params)}）`,
    );
    check(gw.state.pendingClarify === null, '场景2 全部 qid 锁定后服务端清空挂起');
    await page.screenshot({path: `${OUT}/web-pending-clarify-3-batch-answered.png`});

    // ─── 6. 场景 3：无挂起交互（回归）────────────────────────────
    await reopen();
    check(dialogs.length === 0, '场景3 无挂起时打开无弹窗');
    check((await cardText()) === 0, '场景3 不再渲染澄清卡');
    check(
      await page.getByPlaceholder('发消息…').isVisible(),
      '场景3 聊天页正常可用',
    );
    await page.screenshot({path: `${OUT}/web-pending-clarify-4-no-pending.png`});

    console.log(failures === 0 ? '\n全场景 PASS' : `\n${failures} 项断言 FAIL`);
    if (failures > 0) {
      process.exitCode = 1;
    }
  } finally {
    await browser.close().catch(() => {});
    // 注意：kill 传 signal 而非回调（回调会被当成 signal 触发 ERR_UNKNOWN_SIGNAL）
    vite.kill('SIGTERM');
    await gw?.close().catch(() => {});
  }
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
