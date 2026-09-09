/**
 * web-scroll-follow-smoke.js — 聊天流式输出滚动跟随冒烟（上滑暂停/回底恢复/
 * 发送回底，Playwright 真实浏览器操作）。
 *
 * 全程**不打真实 gateway**：本地起 mock-gateway（prompt.submit 流式回包，
 * message.start → delta×N → complete），vite 上游经 HERMES_VITE_UPSTREAM 指
 * 向 mock，浏览器添加直连配置全链路验证。
 *
 * 断言「视口内可见文本」而非 offset 数字（inverted 列表 + 平台锚定行为差异
 * 下，阅读位置稳定才是用户可感知的正确性）：
 *   0. 长历史首滚（非流式）：进会话后向上滚入未挂载的历史区，旧 cell 懒挂载
 *      使 contentSize 阶梯增长——非流式增长**不得触发锚定补偿**，scrollTop
 *      必须只等于累计滚轮量（超出的前向跳变即「首滚抖动」回归）；
 *   1. 贴底发消息：流式全程视图钉底（scrollTop≈0，最新段可见）；
 *   2. 流式中途上滑：记录视口顶部可见段，后续多个 delta 到达后它仍在视口
 *      （阅读位置不被内容增长拖走）；
 *   3. 点「↓ 回到底部」：恢复跟随，剩余输出保持钉底；
 *   4. 上滑状态下自己发消息：视图立即回底并跟随新 turn 全程。
 *
 * 前置：npx playwright-core install chromium（脚本自起 vite 与 mock gateway）。
 * 用法：node scripts/web-scroll-follow-smoke.js
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
const CHUNKS = 26;
const INTERVAL_MS = 450; // 总流式时长 ≈ 12s，留足操作窗口
const VIEW_H = 900;

const EXE = chromium.executablePath();
if (!fs.existsSync(EXE)) {
  console.error(`未找到 Chromium：${EXE}`);
  console.error('请先安装：npx playwright-core install chromium');
  process.exit(1);
}

const MARKER = n => `【第 ${n}/${CHUNKS} 段】`;

let gw;

async function main() {
  // ─── 1. mock gateway + vite（上游指向 mock）─────────────────────
  gw = await startMockGateway({
    port: MOCK_PORT,
    title: '滚动跟随冒烟',
    stream: {chunks: CHUNKS, intervalMs: INTERVAL_MS},
    historyCount: 200, // 场景 0：内容须高过初始渲染窗（windowSize≈21 视口），上滚途中才会懒挂载
  });
  console.log(`mock gateway: http://127.0.0.1:${gw.port}`);

  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const viteEnv = {
    ...process.env,
    HERMES_VITE_UPSTREAM: `http://127.0.0.1:${MOCK_PORT}`,
  };
  // 用「build + preview」而非 dev server：dev 在首次打开聊天界面时会发现新
  // 依赖（markdown-it 等）触发重新预构建 + 整页 reload，App 被重启回首页。
  // preview 静态服务无运行时依赖发现，proxy 复用 server.proxy 配置。
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
    // 等 vite 就绪（stdout 解析 + 探活双保险）
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

    // ─── 2. 浏览器：隔离配置 → 添加直连 → 连接 → 进会话 ───────────
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
    await page.getByPlaceholder('例如：本机 gateway').fill('滚动冒烟-直连');
    await page.getByText('保存', {exact: true}).click();
    await page.getByText('滚动冒烟-直连').waitFor({timeout: 5000});
    await page.getByText('滚动冒烟-直连').click();
    await page.waitForSelector('[aria-label^="打开 profile"]', {timeout: 20000});
    await page.waitForTimeout(1000);
    await page.locator('[aria-label^="打开 profile"]').first().click();
    await page.getByText('新会话', {exact: true}).waitFor({timeout: 10000});
    await page.waitForTimeout(800);
    // 进 mock 会话
    await page.getByText('滚动跟随冒烟').first().click();
    await page.getByPlaceholder('发消息…').waitFor({timeout: 10000});
    await page.waitForTimeout(600);

    // ─── 页内工具：找 inverted 滚动容器 / 读滚动状态 / 段落可见性 ──
    const readScroll = () =>
      page.evaluate(() => {
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
        return best
          ? {
              scrollTop: best.scrollTop,
              scrollHeight: best.scrollHeight,
              clientHeight: best.clientHeight,
            }
          : null;
      });

    const markerBox = async n => {
      const loc = page.getByText(MARKER(n), {exact: false}).first();
      if ((await loc.count()) === 0) {
        return null;
      }
      return loc.boundingBox();
    };
    /** 流推进判定：段已渲染进 DOM（上滑暂停时它在视口下方，属正确行为） */
    const markerInDom = async n =>
      (await page.getByText(MARKER(n), {exact: false}).count()) > 0;
    /** 跟随/钉底判定：段在视口内可见 */
    const markerVisible = async n => {
      const b = await markerBox(n);
      return !!b && b.y < VIEW_H && b.y + b.height > 0;
    };
    const eventually = async (fn, timeoutMs, label) => {
      const start = Date.now();
      let last = null;
      while (Date.now() - start < timeoutMs) {
        try {
          last = await fn();
          if (last) {
            return last;
          }
        } catch (e) {
          last = e;
        }
        await page.waitForTimeout(200);
      }
      throw new Error(`等待超时: ${label}（last=${last}）`);
    };
    const wheelUp = async px => {
      // 鼠标移到滚动容器实际中心（两栏布局下聊天列在右半屏，固定坐标会落空）
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

    // ─── 3. 场景 0：长历史首滚，非流式增长不得触发补偿跳变 ───────
    // 贴底 → 分档位向上滚：每档后 scrollTop 必须只等于累计滚轮量（+容差）。
    // 旧 cell 懒挂载会让 scrollHeight 阶梯增长——这正是被测的增长路径；
    // 若锚定补偿误触发（非流式也补偿），scrollTop 会超出累计滚轮量明显前跳。
    {
      const s0 = await readScroll();
      if (!s0 || s0.scrollTop > 40) {
        throw new Error(`进会话未贴底：scrollTop=${s0?.scrollTop}`);
      }
      const NOTCH = 320;
      const NOTCHES = 10;
      const SLACK = 60;
      let cumulative = 0;
      let observedH = s0.scrollHeight;
      let mounted = false;
      for (let i = 1; i <= NOTCHES; i++) {
        await wheelUp(NOTCH);
        cumulative += NOTCH;
        const s = await readScroll();
        if (!s) {
          throw new Error('未找到 inverted 滚动容器');
        }
        if (s.scrollHeight > observedH + 50) {
          mounted = true; // 懒挂载确实发生了，断言路径有效
          observedH = s.scrollHeight;
        }
        if (s.scrollTop > cumulative + SLACK) {
          throw new Error(
            `非流式上滚前向跳变：第 ${i} 档 scrollTop=${Math.round(
              s.scrollTop,
            )} > 累计滚轮 ${cumulative}+${SLACK}`,
          );
        }
      }
      if (!mounted) {
        throw new Error(
          '全程未见 contentSize 增长：历史种子不足以触发懒挂载，场景无效',
        );
      }
      await page.screenshot({
        path: `${OUT}/web-scroll-follow-0-history.png`,
      });
      console.log(
        `OK 长历史首滚：懒挂载触发（scrollHeight 增至 ${observedH}），scrollTop 未见补偿跳变`,
      );
      // 滚回底部，后续流式场景从贴底开始（按钮是动画滚动，长距离需轮询等稳）
      await page.getByText('↓ 回到底部').click();
      await eventually(
        async () => ((await readScroll())?.scrollTop ?? Infinity) <= 40,
        8000,
        '场景 0 结束未回到贴底',
      );
    }

    // ─── 4. 贴底发消息：流式全程钉底 ─────────────────────────────
    await page.getByPlaceholder('发消息…').fill('滚动跟随冒烟第一条');
    await page.getByText('发送', {exact: true}).click();
    await eventually(() => markerInDom(2), 8000, '第 2 段未出现');
    for (const n of [3, 5, 7]) {
      await eventually(() => markerInDom(n), 15000, `第 ${n} 段未出现`);
      const s = await readScroll();
      if (!s || s.scrollTop > 40) {
        throw new Error(`跟随态被破坏：第 ${n} 段时 scrollTop=${s?.scrollTop}`);
      }
    }
    await page.screenshot({path: `${OUT}/web-scroll-follow-1-following.png`});
    console.log('OK 贴底跟随：流式全程 scrollTop≈0，最新段可见');

    // ─── 5. 中途上滑：阅读位置不被拖走 ───────────────────────────
    // 等内容高过视口（可滚动）再上滑
    await eventually(() => markerInDom(16), 20000, '第 16 段未出现');
    await wheelUp(700);
    const paused = await readScroll();
    if (
      !paused ||
      paused.scrollHeight <= paused.clientHeight + 100 ||
      paused.scrollTop < 100
    ) {
      throw new Error(
        `上滑未生效：scrollTop=${paused?.scrollTop} scrollHeight=${paused?.scrollHeight} clientHeight=${paused?.clientHeight}`,
      );
    }
    // 记录上滑后视口内最靠上（y 最小）的可见段
    let anchor = null;
    let anchorY = Infinity;
    for (let n = 1; n <= 18; n++) {
      const b = await markerBox(n);
      if (b && b.y >= -5 && b.y < VIEW_H && b.y < anchorY) {
        anchor = n;
        anchorY = b.y;
      }
    }
    if (!anchor) {
      throw new Error('上滑后视口内没有任何段可用于锚定断言');
    }
    console.log(`上滑生效：scrollTop=${Math.round(paused.scrollTop)}，锚定段=第 ${anchor} 段`);
    await page.screenshot({path: `${OUT}/web-scroll-follow-2-paused.png`});

    // 流继续推进若干段后，锚定段必须仍在视口（没被拖到底部也没飘出视口）
    await eventually(() => markerInDom(23), 20000, '流未推进到第 23 段');
    if (!(await markerVisible(anchor))) {
      throw new Error(`暂停跟随失败：第 ${anchor} 段在流式推进后飘出视口`);
    }
    const paused2 = await readScroll();
    if (paused2.scrollTop < 100) {
      throw new Error(`暂停期间视口被拉回底部：scrollTop=${paused2.scrollTop}`);
    }
    console.log(`OK 上滑暂停：第 ${anchor} 段稳定可见（scrollTop=${Math.round(paused2.scrollTop)}）`);

    // ─── 6. 「↓ 回到底部」：恢复跟随 ─────────────────────────────
    await page.getByText('↓ 回到底部').click();
    await page.waitForTimeout(500);
    const resumed = await readScroll();
    if (!resumed || resumed.scrollTop > 40) {
      throw new Error(`回到底部未生效：scrollTop=${resumed?.scrollTop}`);
    }
    await eventually(() => markerVisible(CHUNKS), 20000, '流未到末段');
    await page.waitForTimeout(800); // complete 落地（发送按钮恢复）后再采样
    const resumed2 = await readScroll();
    if (resumed2.scrollTop > 40) {
      throw new Error(`恢复跟随失败：流结束后 scrollTop=${resumed2.scrollTop}`);
    }
    if (!(await markerVisible(CHUNKS))) {
      throw new Error('恢复跟随失败：末段不可见');
    }
    await page.screenshot({path: `${OUT}/web-scroll-follow-3-resumed.png`});
    console.log('OK 回到底部：恢复跟随，剩余输出保持钉底');

    // ─── 7. 上滑状态发送消息：立即回底并跟随新 turn ──────────────
    await wheelUp(700);
    const beforeSend = await readScroll();
    if (!beforeSend || beforeSend.scrollTop < 100) {
      throw new Error(`第二次上滑未生效：scrollTop=${beforeSend?.scrollTop}`);
    }
    await page.getByPlaceholder('发消息…').fill('滚动跟随冒烟第二条');
    await page.getByText('发送', {exact: true}).click();
    await page.waitForTimeout(800);
    const afterSend = await readScroll();
    if (!afterSend || afterSend.scrollTop > 40) {
      throw new Error(`发送未回底：scrollTop=${afterSend?.scrollTop}`);
    }
    // 新 turn 开始（首段标记出现第二次）且全程钉底到结束
    await eventually(
      async () => (await page.getByText(MARKER(1), {exact: false}).count()) >= 2,
      15000,
      '第二条流未开始',
    );
    await page.waitForTimeout(1200);
    const mid2 = await readScroll();
    if (mid2.scrollTop > 40) {
      throw new Error(`新 turn 跟随被破坏：scrollTop=${mid2.scrollTop}`);
    }
    await eventually(
      async () =>
        (await page.getByText(MARKER(CHUNKS), {exact: false}).count()) >= 2,
      25000,
      '第二条流未结束',
    );
    await page.waitForTimeout(800);
    const end2 = await readScroll();
    if (end2.scrollTop > 40) {
      throw new Error(`第二条流结束前跟随被破坏：scrollTop=${end2.scrollTop}`);
    }
    await page.screenshot({path: `${OUT}/web-scroll-follow-4-send-jump.png`});
    console.log('OK 发送回底：视图立即回底并跟随新 turn 全程');

    const submits = gw.state.calls.filter(c => c.method === 'prompt.submit');
    if (submits.length !== 2) {
      throw new Error(`prompt.submit 次数异常：${submits.length}`);
    }
    await browser.close();
    page = null;
    console.log('PASS 滚动跟随冒烟全部通过');
  } catch (e) {
    if (page) {
      await page
        .screenshot({path: `${OUT}/web-scroll-follow-fail.png`})
        .catch(() => {});
      // DOM 探针：各段是否已渲染（innerText 含滚动容器外的全部内容）
      const probe = await page
        .evaluate(chunks => {
          const txt = document.body.innerText || '';
          let out = '';
          for (let n = 1; n <= chunks; n++) {
            out += txt.includes(`【第 ${n}/${chunks} 段】`) ? '1' : '0';
          }
          return out;
        }, CHUNKS)
        .catch(err => `probe失败: ${String(err).slice(0, 120)}`);
      console.log(`[诊断] DOM 各段渲染位图: ${probe}`);
      console.log(`[诊断] mock deltaSent=${gw.state.deltaSent}`);
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
