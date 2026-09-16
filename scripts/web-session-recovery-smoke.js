/**
 * web-session-recovery-smoke.js — 「live sid 被回收后发送自愈」冒烟。
 *
 * 背景（2026-09-16 用户报障）：live sid 是易逝的——WS 断开 ~20s 被孤儿回收、
 * 闲置 TTL 回收、（SSH 隧道下）随 hermes serve 进程死亡。此前：
 *  a) 长停留会话重连后 resume 冷路径换新 sid，reattachAfterResume 删旧 key →
 *     挂载中的聊天页时间线空白、发送打旧 sid 报「session not found」；
 *  b) 新建空会话等待期间被回收：服务端首次 prompt 前不落库 → resume 4007、
 *     session.list 永远不可见（重进无门）、发送必失败。
 * 修复：reattach 保留 migratedTo shell 让页面跟随 + session.reclaimed 全局
 * 广播接线 + 发送时自愈（resume / 空会话重建）。
 *
 * 全程不打真实 gateway：mock-gateway 提供 session.create、resume 冷路径换新
 * live sid、prompt.submit 只认 live sid（未知 4007）、reapLiveSession 控制
 * 通道（广播/静默两种回收形态）。vite 上游经 HERMES_VITE_UPSTREAM 指向 mock。
 *
 * 场景：
 *   A. 空会话被回收（广播 session.reclaimed → 客户端 staleLive 快路径）：
 *      发送 → resume 4007 → session.create 重建 → 新 sid 发送成功，
 *      自动恢复灰条可见；回列表后该会话可见（首条消息落库）。
 *   B. 老会话被静默回收（网关进程死亡形态，客户端无感知）：
 *      发送 → prompt.submit 撞旧 sid 4007 → resume 冷路径换新 sid →
 *      页面跟随（历史不丢）→ 新 sid 发送成功。
 *
 * 前置：npx playwright-core install chromium（脚本自起 vite build+preview 与 mock）。
 * 用法：node scripts/web-session-recovery-smoke.js
 */

const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright-core');

const {startMockGateway} = require('./mock-gateway');

const ROOT = path.join(__dirname, '..');
const OUT = 'docs/screenshots';
// 与其他冒烟（9199/5188、9201/5189、9202/5190、9203/5191）错开端口
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 9204);
const VITE_PORT = Number(process.env.SMOKE_VITE_PORT || 5192);
const VIEW = {width: 1100, height: 900};
const TITLE = '会话回收冒烟';
const CONN_NAME = '冒烟直连D';
const STREAM = {chunks: 6, intervalMs: 120};

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

/** 等 mock 调用流水里出现满足条件的记录（客户端 RPC 是异步的） */
async function waitForCall(pred, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = gw.state.calls.find(pred);
    if (hit) {
      return hit;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}

async function main() {
  // ─── 1. mock gateway + vite（上游指向 mock）─────────────────────
  gw = await startMockGateway({
    port: MOCK_PORT,
    title: TITLE,
    stream: STREAM,
  });
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

    // ─── 2. 浏览器：隔离配置 → 添加直连 → 连接（固定 zh-CN 断言中文文案）──
    const context = await browser.newContext({
      viewport: VIEW,
      locale: 'zh-CN',
    });
    page = await context.newPage();
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

    /** reload 后回到会话列表（自动重连 → 打开 profile） */
    const enterSessionList = async () => {
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
    };
    const send = async text => {
      await page.getByPlaceholder('发消息…').fill(text);
      await page.getByText('发送', {exact: true}).click();
    };
    const callsOf = method => gw.state.calls.filter(c => c.method === method);

    // ─── 3. 场景 A：空会话被回收（广播）→ 发送自愈重建 ─────────────
    await enterSessionList();
    await page.getByText('新会话', {exact: true}).first().click();
    await page.getByPlaceholder('发消息…').waitFor({timeout: 10000});
    await page.waitForTimeout(400);
    check(
      callsOf('session.create').length === 1,
      `A1 session.create 已发（${callsOf('session.create').length}）`,
    );
    const liveA = gw.state.extraSessions[0]?.liveSid;
    check(!!liveA, `A2 新会话 live sid = ${liveA}`);

    gw.reapLiveSession(liveA, 'ws_orphan_reap');
    await page.waitForTimeout(300); // 广播到达 → staleLive
    await send('空会话自愈冒烟消息');

    // 自愈链：resume(storedN…) 4007 → session.create 重建 → 新 sid 提交
    const resumeA = await waitForCall(
      c =>
        c.method === 'session.resume' &&
        String(c.params?.session_id ?? '').startsWith('storedN'),
    );
    check(!!resumeA, 'A3 自愈先 resume 持久化 id');
    await waitForCall(
      c => c.method === 'session.create' && callsOf('session.create')[1] === c,
    );
    check(
      callsOf('session.create').length === 2,
      'A4 resume 4007 后重建会话（第二次 session.create）',
    );
    const liveA2 = gw.state.extraSessions[0]?.liveSid;
    const submitA = await waitForCall(
      c => c.method === 'prompt.submit' && c.params?.text === '空会话自愈冒烟消息',
    );
    check(
      !!submitA && submitA.params?.session_id === liveA2,
      `A5 重建后的会话里提交（prompt.submit sid=${submitA?.params?.session_id}，期望 ${liveA2}）`,
    );
    await page
      .getByText('空会话自愈冒烟消息', {exact: false})
      .first()
      .waitFor({timeout: 8000});
    check(
      (await page.getByText('发送失败', {exact: false}).count()) === 0,
      'A6 无「发送失败」红条',
    );
    check(
      (await page.getByText('会话已自动恢复', {exact: false}).count()) === 1,
      'A7 「自动恢复」系统灰条可见',
    );
    await page
      .getByText('流式滚动跟随冒烟测试文本', {exact: false})
      .first()
      .waitFor({timeout: 8000});
    check(true, 'A8 重建会话里流式回复到达');
    await page.screenshot({path: `${OUT}/web-session-recovery-0-empty-recreated.png`});

    // 回列表：重建的会话已落库、可见（修复前：空会话回收后列表永不可见）。
    // 列表行以摘要文本识别（「新会话」三字与左上角新建按钮同文案，不可数）。
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForTimeout(1500);
    await enterSessionList();
    const rowPreview = page
      .getByText('流式滚动跟随冒烟测试文本', {exact: false})
      .first();
    check(
      (await rowPreview.count()) > 0 && (await rowPreview.isVisible()),
      'A9 重建会话出现在列表（行摘要含回复文本）',
    );
    await page.screenshot({path: `${OUT}/web-session-recovery-1-list.png`});

    // ─── 4. 场景 B：老会话被静默回收（网关进程死亡形态）→ 撞 4007 自愈 ──
    await page.getByText(TITLE, {exact: true}).first().click();
    await page.getByPlaceholder('发消息…').waitFor({timeout: 10000});
    check(
      (await page.getByText('你好，这是 mock 会话', {exact: false}).count()) >= 1,
      'B1 打开 seed 会话：历史可见',
    );
    await page.waitForTimeout(400);

    // 静默回收（不广播）：客户端不知道，发送直接撞旧 sid 4007
    check(
      gw.reapLiveSession('live0001', 'idle_timeout', {broadcast: false}),
      'B2 seed 会话已静默回收',
    );
    await send('老会话自愈冒烟消息');

    const failedSubmit = await waitForCall(
      c =>
        c.method === 'prompt.submit' && c.params?.session_id === 'live0001',
    );
    check(!!failedSubmit, 'B3 首次提交打旧 sid（mock 返 4007）');
    // 等自愈完成：新 sid 的提交落地
    await waitForCall(
      c =>
        c.method === 'prompt.submit' &&
        c.params?.text === '老会话自愈冒烟消息' &&
        c.params?.session_id === 'live0002',
    );
    const resumes = callsOf('session.resume');
    check(
      resumes[resumes.length - 1]?.params?.session_id === 'stored-mock-0001',
      'B4 自愈 resume 持久化 id（冷路径换新 sid）',
    );
    const submitsB = callsOf('prompt.submit').filter(
      c => c.params?.text === '老会话自愈冒烟消息',
    );
    check(
      submitsB.length === 2 &&
        submitsB[0].params?.session_id === 'live0001' &&
        submitsB[1].params?.session_id === 'live0002',
      `B5 先撞 live0001 再在 live0002 重发（${submitsB.map(c => c.params?.session_id)}）`,
    );
    await page
      .getByText('老会话自愈冒烟消息', {exact: false})
      .first()
      .waitFor({timeout: 8000});
    check(
      (await page.getByText('发送失败', {exact: false}).count()) === 0,
      'B6 无「发送失败」红条',
    );
    // 页面跟随新 sid：历史 + 新消息同屏（修复前：旧 key 被删 → 时间线空白）
    check(
      (await page.getByText('你好，这是 mock 会话', {exact: false}).count()) >= 1,
      'B7 迁移后历史仍在（页面跟随新 sid）',
    );
    check(
      (await page.getByText('会话已自动恢复', {exact: false}).count()) === 1,
      'B8 「自动恢复」系统灰条可见',
    );
    await page
      .getByText('流式滚动跟随冒烟测试文本', {exact: false})
      .first()
      .waitFor({timeout: 8000});
    check(true, 'B9 新 sid 流式回复到达');
    await page.screenshot({path: `${OUT}/web-session-recovery-2-seed-healed.png`});

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
