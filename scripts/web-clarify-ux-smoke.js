/**
 * web-clarify-ux-smoke.js — clarify 显示归位 + 草稿式整体提交冒烟（D052）。
 *
 * 被测行为（mock-gateway live clarify 流，CLARIFY_BATCH 触发）：
 *   1. 挂起中：澄清卡在会话底部，批量两题（单选 + 自由文本），
 *      提交按钮禁用 + 「还有 N 题未作答」提示；
 *   2. 新交互：点选项只落草稿（不立即发送）；填完两题后「提交回答」
 *      点亮，一次点击按题目顺序连发两次 clarify.respond（带 question_id），
 *      已答题展示「你的回答：…」；
 *   3. 归位：全部应答后 agent 续写渲染在澄清卡**下方**（卡片不再钉底）；
 *   4. 重进会话：历史投影的 clarify 工具行合成只读卡，位置正确
 *      （前文 → 澄清卡 → 续写），无提交按钮、题目显示「已作答」。
 *
 * 前置：npx playwright-core install chromium（脚本自起 vite build+preview 与 mock）。
 * 用法：node scripts/web-clarify-ux-smoke.js
 */

const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright-core');

const {startMockGateway} = require('./mock-gateway');

const ROOT = path.join(__dirname, '..');
const OUT = 'docs/screenshots';
// 与其他冒烟（9199/5188 … 9203/5191）错开，避免并行会话占口
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 9204);
const VITE_PORT = Number(process.env.SMOKE_VITE_PORT || 5192);
const VIEW = {width: 900, height: 900};
const TITLE = '澄清归位冒烟';
const CONN_NAME = '冒烟直连D';

const Q0 = '使用哪个数据集？';
const Q1 = '时间范围是？';
const PRE_TEXT = '好的，在动手前先确认：';
const CONT_MARK = 'CLARIFY_CONTINUATION_MARK';

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

async function waitUntil(fn, timeout = 10000, step = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) {
      return true;
    }
    await new Promise(r => setTimeout(r, step));
  }
  return await fn();
}

/** 元素中心 y 坐标（视口内不可见时为 null） */
async function centerY(page, locator) {
  const box = await locator.first().boundingBox();
  return box ? box.y + box.height / 2 : null;
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

    // ─── 2. 浏览器：隔离配置 → 直连 → 进会话 ──────────────────────
    page = await browser.newPage({viewport: VIEW});
    page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));

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
      await page.getByPlaceholder('发消息…').waitFor({timeout: 15000});
      await page.waitForTimeout(500);
    };
    const respondCalls = () =>
      gw.state.calls.filter(c => c.method === 'clarify.respond');
    const cardTitle = () => page.getByText('💬 需要你的回答');

    await enterSession();

    // ─── 3. 场景 1：发 CLARIFY_BATCH → 挂起卡 + 草稿态 ─────────────
    await page.getByPlaceholder('发消息…').fill('CLARIFY_BATCH');
    await page.getByText('发送', {exact: true}).click();
    const pendingShown = await waitUntil(async () => (await cardTitle().count()) === 1);
    check(pendingShown, '场景1 挂起后澄清卡渲染');
    check(
      await page.getByText(Q0).first().isVisible(),
      '场景1 问题一（单选）可见',
    );
    check(
      await page.getByText(Q1).first().isVisible(),
      '场景1 问题二（自由文本）可见',
    );
    check(
      (await page.getByText('还有 2 题未作答').count()) === 1,
      '场景1 未填草稿时提示「还有 2 题未作答」',
    );
    // 挂起期间无续写输出（服务端阻塞在工具上）
    check(
      (await page.getByText(CONT_MARK).count()) === 0,
      '场景1 挂起期间无续写输出',
    );
    await page.screenshot({path: `${OUT}/web-clarify-ux-1-pending.png`});

    // ─── 4. 场景 2：填草稿（不立即发送）→ 整体提交 ────────────────
    await page.getByText('A数据集', {exact: true}).first().click();
    await page.waitForTimeout(300);
    check(
      respondCalls().length === 0,
      '场景2 点选项只落草稿、不立即发送',
    );
    check(
      (await page.getByText('还有 1 题未作答').count()) === 1,
      '场景2 一题草稿后提示剩余 1 题',
    );
    await page
      .getByPlaceholder('或直接输入回答…')
      .last()
      .fill('最近 30 天');
    check(
      (await page.getByText('还有', {exact: false}).count()) === 0,
      '场景2 两题草稿齐后不再提示未答',
    );
    await page.getByText('提交回答', {exact: true}).click();
    const responded = await waitUntil(() => respondCalls().length >= 2);
    check(responded, '场景2 提交后连发两次 clarify.respond');
    const [r0, r1] = respondCalls().map(c => c.params);
    check(
      r0?.question_id === 'q0' && r0?.answer === 'A数据集',
      `场景2 第一发带 q0/选项文本（${JSON.stringify(r0)}）`,
    );
    check(
      r1?.question_id === 'q1' && r1?.answer === '最近 30 天',
      `场景2 第二发带 q1/自定义文本（${JSON.stringify(r1)}）`,
    );

    // ─── 5. 场景 3：归位——续写渲染在卡片下方 ─────────────────────
    const answersShown = await waitUntil(async () =>
      (await page.getByText('你的回答：A数据集').count()) === 1 &&
      (await page.getByText('你的回答：最近 30 天').count()) === 1,
    );
    check(answersShown, '场景3 已答题展示「你的回答：…」');
    const continuationShown = await waitUntil(
      async () => (await page.getByText(CONT_MARK).count()) > 0,
      15000,
    );
    check(continuationShown, '场景3 释放后 agent 续写输出');
    const cardY = await centerY(page, cardTitle());
    const contY = await centerY(page, page.getByText(CONT_MARK).first());
    const preY = await centerY(page, page.getByText(PRE_TEXT, {exact: true}));
    check(
      cardY !== null && contY !== null && cardY < contY,
      `场景3 续写在卡片下方（cardY=${cardY} contY=${contY}）`,
    );
    check(
      preY !== null && cardY !== null && preY < cardY,
      `场景3 卡片在前文之后（preY=${preY} cardY=${cardY}）`,
    );
    await page.waitForTimeout(2500); // 等续写 + complete 收尾
    await page.screenshot({path: `${OUT}/web-clarify-ux-2-answered.png`});

    // ─── 6. 场景 4：重进会话 → 历史只读卡位置正确 ────────────────
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForTimeout(1500);
    await enterSession();
    const historyCard = await waitUntil(async () => (await cardTitle().count()) === 1);
    check(historyCard, '场景4 历史投影合成澄清卡（重进后仍在）');
    check(
      (await page.getByText(Q0).count()) === 1,
      '场景4 历史卡问题可见',
    );
    check(
      (await page.getByText('已作答', {exact: true}).count()) >= 2,
      '场景4 历史卡（无答案文本）题目显示「已作答」',
    );
    check(
      (await page.getByText('提交回答', {exact: true}).count()) === 0,
      '场景4 历史卡无提交按钮',
    );
    const hPreY = await centerY(page, page.getByText(PRE_TEXT, {exact: true}));
    const hCardY = await centerY(page, cardTitle());
    const hContY = await centerY(page, page.getByText(CONT_MARK).first());
    check(
      hPreY !== null && hCardY !== null && hContY !== null &&
        hPreY < hCardY && hCardY < hContY,
      `场景4 历史顺序：前文 → 澄清卡 → 续写（${hPreY} / ${hCardY} / ${hContY}）`,
    );
    check(
      (await page.getByText(CONT_MARK).count()) === 3,
      '场景4 续写内容不重复（3 处标记）',
    );
    await page.screenshot({path: `${OUT}/web-clarify-ux-3-history.png`});

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
