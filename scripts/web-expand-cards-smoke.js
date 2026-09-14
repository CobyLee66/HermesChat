/**
 * web-expand-cards-smoke.js — 流式输出期间展开/收起推理块与工具调用卡的冒烟
 * （Playwright 真实鼠标操作）。
 *
 * 背景（修复的 bug）：RNW 的 TouchableOpacity.onPress 走 DOM click 事件，
 * mousedown 与 mouseup 须落在同一元素；流式钉底期间内容增长把卡片顶走，
 * click 永不触发——桌面/web 在 agent 输出期间结构性点不开卡片（修复前实测
 * 真实鼠标点击 6/6 失败）。修复：web 端改为 onPressIn（mousedown 落点瞬间）
 * 切换，onPress 仅放行键盘/程序化 click（detail=0）。本冒烟用**真实鼠标**在
 * 流式进行中点击卡片头，覆盖该契约路径。
 *
 * 断言（mock rich 事件流，见 mock-gateway.js stream.rich）：
 *   1. 流式中点击「推理过程」→ 中部标记 RICH_REASONING_MID 出现（展开成功）；
 *   2. 继续流式 3s 后仍展开（无 remount/状态重置）；
 *   3. 流式中再点一次收起；再点重新展开；
 *   4. 点击工具卡 → 结果尾部标记 RICH_TOOL_RESULT_END 出现；
 *   5. 流式结束后工具卡/推理卡收起+展开回归。
 *
 * 前置：npx playwright-core install chromium（脚本自起 vite 与 mock gateway）。
 * 用法：node scripts/web-expand-cards-smoke.js
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
const CHUNKS = 8;
const INTERVAL_MS = 500;
const VIEW_H = 900;

const MID = 'RICH_REASONING_MID';
const TOOL_END = 'RICH_TOOL_RESULT_END';
const REASONING_LABEL = '推理过程';
const TOOL_LABEL = 'read_file';

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
    title: '展开卡片冒烟',
    stream: {rich: true, chunks: CHUNKS, intervalMs: INTERVAL_MS},
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
      code === 0 ? resolve() : reject(new Error(`vite build 失败:\n${err.slice(-800)}`)),
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

    page = await browser.newPage({viewport: {width: 900, height: VIEW_H}});
    page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
    await page.goto(viteUrl, {waitUntil: 'domcontentloaded'});
    await page.waitForTimeout(1500);
    await page.evaluate(() => localStorage.clear());
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForTimeout(1200);

    await page.getByText('＋ 添加配置').click();
    await page.getByText('连接类型').waitFor({timeout: 5000});
    await page.getByText('直连', {exact: true}).click();
    await page.getByPlaceholder('例如：本机 gateway').fill('展开冒烟-直连');
    await page.getByText('保存', {exact: true}).click();
    await page.getByText('展开冒烟-直连').waitFor({timeout: 5000});
    await page.getByText('展开冒烟-直连').click();
    await page.waitForSelector('[aria-label^="打开 profile"]', {timeout: 20000});
    await page.waitForTimeout(1000);
    await page.locator('[aria-label^="打开 profile"]').first().click();
    await page.getByText('新会话', {exact: true}).waitFor({timeout: 10000});
    await page.waitForTimeout(800);
    await page.getByText('展开卡片冒烟').first().click();
    await page.getByPlaceholder('发消息…').waitFor({timeout: 10000});
    await page.waitForTimeout(600);

    // ─── 页内工具 ─────────────────────────────────────────────
    const bodyText = () => page.evaluate(() => document.body.innerText || '');
    const labelLoc = label =>
      page.getByText(label, {exact: label === REASONING_LABEL}).first();
    /** 真实鼠标点击标签中心（每次取最新坐标；流式布局移动下的落点由重试兜底） */
    const clickLabel = async label => {
      const loc = labelLoc(label);
      if ((await loc.count()) === 0) {
        return false;
      }
      const box = await loc.boundingBox();
      if (!box || box.y < 0 || box.y + box.height > VIEW_H) {
        return false;
      }
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      return true;
    };
    const wheelUp = async px => {
      const rect = await page.evaluate(() => {
        let best = null;
        for (const el of document.querySelectorAll('div')) {
          const cs = getComputedStyle(el);
          if (
            (cs.transform || '').startsWith('matrix(1, 0, 0, -1') &&
            (cs.overflowY === 'scroll' || cs.overflowY === 'auto')
          ) {
            if (!best || el.scrollHeight > best.scrollHeight) {
              best = el;
            }
          }
        }
        if (!best) {
          return null;
        }
        const r = best.getBoundingClientRect();
        return {x: r.x + r.width / 2, y: r.y + r.height / 2};
      });
      if (!rect) {
        throw new Error('未找到 inverted 滚动容器');
      }
      await page.mouse.move(rect.x, rect.y);
      await page.mouse.wheel(0, -px);
      await page.waitForTimeout(400);
    };
    /** 卡片随正文增长被顶出视口后，向上滚回可见范围（真实用户行为） */
    const ensureVisible = async label => {
      for (let i = 0; i < 12; i++) {
        const loc = labelLoc(label);
        if ((await loc.count()) > 0) {
          const box = await loc.boundingBox();
          if (box && box.y > 30 && box.y + box.height < VIEW_H - 30) {
            return true;
          }
        }
        await wheelUp(500);
      }
      return false;
    };
    /** 点击直到标记出现（展开成功）；返回所用次数，-1 = 始终失败 */
    const clickUntilExpanded = async (label, marker, maxAttempts = 8) => {
      for (let a = 1; a <= maxAttempts; a++) {
        await clickLabel(label);
        await page.waitForTimeout(400);
        if ((await bodyText()).includes(marker)) {
          return a;
        }
        await page.waitForTimeout(150);
      }
      return -1;
    };

    // ─── 1. 流式中真实鼠标点击展开推理块 ──────────────────────
    await page.getByPlaceholder('发消息…').fill('展开卡片冒烟第一条');
    await page.getByText('发送', {exact: true}).click();
    await page
      .getByText(REASONING_LABEL, {exact: true})
      .waitFor({timeout: 15000});
    // 等中部标记 delta 到达（mock 前序推理节奏 ≈2s）
    await page.waitForTimeout(2500);
    const reasoningAttempts = await clickUntilExpanded(REASONING_LABEL, MID);
    if (reasoningAttempts < 0) {
      throw new Error('流式中点击「推理过程」始终无法展开（RNW click 契约回归）');
    }
    console.log(`OK 流式中展开推理块（第 ${reasoningAttempts} 次点击生效）`);
    await page.screenshot({path: `${OUT}/web-expand-cards-1-stream-reasoning.png`});

    // ─── 2. 展开状态跨 delta 保持（无 remount/重置）──────────
    await page.waitForTimeout(3000);
    if (!(await bodyText()).includes(MID)) {
      throw new Error('展开后 3s 内被流式重置（状态未保持）');
    }
    console.log('OK 展开状态跨流式 delta 保持');

    // ─── 3. 流式中收起 + 重新展开 ────────────────────────────
    if (!(await ensureVisible(REASONING_LABEL))) {
      throw new Error('推理卡滚出视口且无法滚回');
    }
    await clickLabel(REASONING_LABEL);
    await page.waitForTimeout(400);
    if ((await bodyText()).includes(MID)) {
      throw new Error('流式中再次点击未收起');
    }
    const reopenAttempts = await clickUntilExpanded(REASONING_LABEL, MID);
    if (reopenAttempts < 0) {
      throw new Error('流式中收起后无法重新展开');
    }
    console.log('OK 流式中收起/重新展开');

    // ─── 4. 流式中展开工具卡 ─────────────────────────────────
    if (!(await ensureVisible(TOOL_LABEL))) {
      throw new Error('工具卡滚出视口且无法滚回');
    }
    const toolAttempts = await clickUntilExpanded(TOOL_LABEL, TOOL_END);
    if (toolAttempts < 0) {
      throw new Error('流式中点击工具卡始终无法展开');
    }
    console.log(`OK 流式中展开工具卡（第 ${toolAttempts} 次点击生效）`);
    await page.screenshot({path: `${OUT}/web-expand-cards-2-stream-tool.png`});

    // ─── 5. 流式结束后：收起/展开回归 ────────────────────────
    for (let i = 0; i < 60; i++) {
      if ((await bodyText()).includes(`【第 ${CHUNKS}/${CHUNKS} 段】`)) {
        break;
      }
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(1200);
    if (!(await ensureVisible(TOOL_LABEL))) {
      throw new Error('结束后工具卡不可见');
    }
    await clickLabel(TOOL_LABEL);
    await page.waitForTimeout(400);
    if ((await bodyText()).includes(TOOL_END)) {
      throw new Error('结束后工具卡未收起');
    }
    const postToolAttempts = await clickUntilExpanded(TOOL_LABEL, TOOL_END);
    if (postToolAttempts < 0) {
      throw new Error('结束后工具卡无法重新展开');
    }
    if (!(await ensureVisible(REASONING_LABEL))) {
      throw new Error('结束后推理卡不可见');
    }
    await clickLabel(REASONING_LABEL);
    await page.waitForTimeout(400);
    if ((await bodyText()).includes(MID)) {
      throw new Error('结束后推理卡未收起');
    }
    const postReasoningAttempts = await clickUntilExpanded(REASONING_LABEL, MID);
    if (postReasoningAttempts < 0) {
      throw new Error('结束后推理卡无法重新展开');
    }
    await page.screenshot({path: `${OUT}/web-expand-cards-3-post-stream.png`});
    console.log('OK 流式结束后收起/展开回归');

    await browser.close();
    page = null;
    console.log('PASS 展开卡片冒烟全部通过');
  } catch (e) {
    if (page) {
      await page
        .screenshot({path: `${OUT}/web-expand-cards-fail.png`})
        .catch(() => {});
    }
    throw e;
  } finally {
    await browser.close().catch(() => {});
    vite.kill();
    await gw.close();
  }
}

main().catch(e => {
  console.error('FAIL', e);
  console.error(
    `[诊断] mock deltaSent=${gw.state.deltaSent} wsClosed=${JSON.stringify(
      gw.state.wsClosed,
    )} sockets=${gw.state.sockets} lastSendError=${gw.state.lastSendError}`,
  );
  process.exit(1);
});
