/**
 * web-thinking-tail-smoke.js — 流式推理预览「锚定尾部、最新输出可见」冒烟。
 *
 * 背景（修复的 bug）：折叠+流式态预览是 <Text numberOfLines={2}> 套
 * thinkingTail 的尾部窗口，但 RN/RNW 的 numberOfLines 截断默认 tail 方向
 * （显示字符串开头、省略末尾），且 Android 多行/web line-clamp 只支持
 * tail——200 字符窗口远超两行容量，窗口尾部（真正的最新输出）被 "…" 吃掉
 * 不可见，可见区随窗口滑动呈「句子向左移动逐渐缩短」。修复：thinkingTail
 * 按实测宽度把窗口收敛到恰好放得下两行（截断永不触发）。
 *
 * 断言（mock rich 事件流，见 mock-gateway.js stream.rich）：
 *   1. 流式中采样到含「推理尾段第 4 行」的折叠预览时：
 *      a. 预览文本以真尾（丙×50）结尾（锚定尾部）；
 *      b. 预览文本长度按两行宽度预算收敛（远小于旧固定 200 字符窗）；
 *      c. Range 探针：预览末尾 4 个字符的布局矩形落在元素可视盒内
 *         （最新输出真实渲染可见，未被 line-clamp 裁掉）；
 *   2. 流式结束后折叠预览回落为首行头部预览（thinkingHead 路径回归）。
 *
 * 前置：npx playwright-core install chromium（脚本自起 vite 与 mock gateway）。
 * 用法：node scripts/web-thinking-tail-smoke.js
 */

const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright-core');

const {startMockGateway} = require('./mock-gateway');

const ROOT = path.join(__dirname, '..');
const OUT = 'docs/screenshots';
// 并行会话可能占着 5188/9199（dev server 或另一份冒烟），端口可环境变量换道
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 9199);
const VITE_PORT = Number(process.env.SMOKE_VITE_PORT || 5188);

const REASONING_LABEL = '推理过程';
const HEAD_LINE = '推理首行内容';
const TAIL_MARK = '推理尾段第 4 行';
const STREAM_END_MARK = '【第 24/24 段】';

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
    title: '思考尾窗冒烟',
    stream: {rich: true},
  });
  console.log(`mock gateway: http://127.0.0.1:${gw.port}（rich 事件流）`);

  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const viteEnv = {
    ...process.env,
    HERMES_VITE_UPSTREAM: `http://127.0.0.1:${MOCK_PORT}`,
  };
  // 用「build + preview」而非 dev server：dev 在首次打开聊天界面时会发现新
  // 依赖（markdown-it 等）触发重新预构建 + 整页 reload，App 被重启回首页。
  await new Promise((resolve, reject) => {
    const build = spawn(
      process.execPath,
      [viteBin, 'build'],
      {cwd: ROOT, env: viteEnv, stdio: ['ignore', 'ignore', 'pipe']},
    );
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

    page = await browser.newPage({viewport: {width: 900, height: 900}});
    page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
    await page.goto(viteUrl, {waitUntil: 'domcontentloaded'});
    await page.waitForTimeout(1500);
    await page.evaluate(() => localStorage.clear());
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForTimeout(1200);

    await page.getByText('＋ 添加配置').click();
    await page.getByText('连接类型').waitFor({timeout: 5000});
    await page.getByText('直连', {exact: true}).click();
    await page.getByPlaceholder('例如：本机 gateway').fill('思考尾窗冒烟-直连');
    await page.getByText('保存', {exact: true}).click();
    await page.getByText('思考尾窗冒烟-直连').waitFor({timeout: 5000});
    await page.getByText('思考尾窗冒烟-直连').click();
    await page.waitForSelector('[aria-label^="打开 profile"]', {timeout: 20000});
    await page.waitForTimeout(1000);
    await page.locator('[aria-label^="打开 profile"]').first().click();
    await page.getByText('新会话', {exact: true}).waitFor({timeout: 10000});
    await page.waitForTimeout(800);
    await page.getByText('思考尾窗冒烟').first().click();
    await page.getByPlaceholder('发消息…').waitFor({timeout: 10000});
    await page.waitForTimeout(600);

    /** 页内探针：定位「推理过程」折叠卡内的预览文本，回报内容与尾部可见性 */
    const probePreview = () => {
      const label = [...document.querySelectorAll('div')].find(
        d => d.children.length === 0 && d.textContent === '推理过程',
      );
      if (!label || !label.parentElement) {
        return {found: false};
      }
      const preview = [...label.parentElement.children].find(
        c =>
          c !== label &&
          c.children.length === 0 &&
          (c.textContent || '').length > 0,
      );
      if (!preview) {
        return {found: false};
      }
      const text = preview.textContent || '';
      const node = preview.firstChild;
      let tailVisible = false;
      if (node && node.nodeType === Node.TEXT_NODE && text.length > 0) {
        const range = document.createRange();
        range.setStart(node, Math.max(0, text.length - 4));
        range.setEnd(node, text.length);
        const r = range.getBoundingClientRect();
        const e = preview.getBoundingClientRect();
        tailVisible =
          r.width > 0 && r.bottom <= e.bottom + 2 && r.top >= e.top - 2;
      }
      return {found: true, text, len: text.length, tailVisible};
    };

    // ─── 1. 流式中采样折叠预览：锚定尾部 + 最新输出可见 ────────
    await page.getByPlaceholder('发消息…').fill('触发推理流');
    await page.getByText('发送', {exact: true}).click();
    await page
      .getByText(REASONING_LABEL, {exact: true})
      .waitFor({timeout: 15000});

    let sample = null;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const s = await page.evaluate(probePreview);
      if (s.found && s.text.includes(TAIL_MARK)) {
        sample = s;
        break;
      }
      await page.waitForTimeout(40);
    }
    if (!sample) {
      throw new Error('未能在流式窗口内采到含尾段标记的折叠预览');
    }
    await page.screenshot({path: `${OUT}/web-thinking-tail-live.png`});

    if (!/丙{50}\s*$/.test(sample.text)) {
      throw new Error(
        `预览未锚定最新尾部输出（尾部 60 字符：…${sample.text.slice(-60)}）`,
      );
    }
    console.log('OK 流式预览锚定尾部（以真尾丙×50 结尾）');
    if (sample.len > 160) {
      throw new Error(
        `预览窗口未按宽度收敛（len=${sample.len}，疑似旧固定 200 字符窗）`,
      );
    }
    console.log(`OK 预览窗口按两行宽度收敛（len=${sample.len}）`);
    if (!sample.tailVisible) {
      throw new Error('预览末尾字符被 line-clamp 裁掉，最新输出不可见');
    }
    console.log('OK 最新输出字符在可视盒内（未被截断）');
    if (sample.text.includes(HEAD_LINE)) {
      throw new Error('预览仍含首行内容，窗口未滑向尾部');
    }
    console.log('OK 旧首行内容已滑出预览窗口');

    // ─── 2. 流式结束后回落首行预览（thinkingHead 路径回归）─────
    const t1 = Date.now();
    while (Date.now() - t1 < 20000) {
      if (
        (await page.evaluate(() => document.body.innerText || '')).includes(
          STREAM_END_MARK,
        )
      ) {
        break;
      }
      await page.waitForTimeout(200);
    }
    const t2 = Date.now();
    let headOk = false;
    while (Date.now() - t2 < 5000) {
      const s = await page.evaluate(probePreview);
      if (s.found && s.text.startsWith(HEAD_LINE)) {
        headOk = true;
        break;
      }
      await page.waitForTimeout(200);
    }
    if (!headOk) {
      throw new Error('流式结束后折叠预览未回落为首行头部预览');
    }
    console.log('OK 结束后折叠预览回落首行头部预览');

    console.log('思考尾窗冒烟通过');
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
    await browser.close().catch(() => {});
    vite.kill();
    if (gw) {
      await gw.close();
    }
  }
}

main().catch(async e => {
  console.error('冒烟失败：', e.message || e);
  if (gw) {
    console.error(
      `诊断：deltaSent=${gw.state.deltaSent} wsClosed=${JSON.stringify(
        gw.state.wsClosed,
      )} lastSendError=${gw.state.lastSendError}`,
    );
    await gw.close();
  }
  process.exit(1);
});
