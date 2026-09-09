/**
 * web-session-sort-smoke.js — 会话列表排序档位冒烟（Playwright，只读验证）。
 *
 * 前置：`npx vite` 已运行（localhost:5188），本机 hermes 9119 可达。
 * 流程：
 *   1. 直连 9119 读 session.list{profile:'main'}（只读 RPC），按 App 同口径
 *      （聊天过滤 + 空标题/重名剔除）算出两档期望顺序：
 *      recent = 服务端返回序（服务端已按 last_active 降序），
 *      created = started_at 降序。
 *   2. 浏览器添加直连配置 → 连接 → 进 main 的会话列表。
 *   3. 默认档断言「最近消息」激活且行序 = recent 期望；
 *      点「创建时间」断言行序 = created 期望；localStorage 已落盘。
 *
 * 用法：node scripts/web-session-sort-smoke.js
 */

const fs = require('node:fs');
const {chromium} = require('playwright-core');

// Chromium 路径由 playwright-core 按自身版本自解析（勿硬编码版本目录）
const EXE = chromium.executablePath();
if (!fs.existsSync(EXE)) {
  console.error(`未找到 Chromium：${EXE}`);
  console.error('请先安装：npx playwright-core install chromium');
  process.exit(1);
}
const VITE = 'http://localhost:5188/';
const GATEWAY = 'http://127.0.0.1:9119';
const OUT = 'docs/screenshots';
const PROFILE = 'main';

// 与 src/utils/sessionSources.ts 同口径：dashboard AUTOMATION_SESSION_SOURCES
const AUTOMATION_SOURCES = new Set([
  'cron',
  'tool',
  'api_server',
  'acp',
  'hermes_flow',
  'vulcan_delegate',
  'webhook',
]);

// ─── 期望顺序在 main() 内用只读 RPC 计算 ─────────────────────────

async function main() {
  // 1. 只读拉取 main 列表 + profile 昵称
  const home = await (await fetch(GATEWAY + '/')).text();
  const token = home.match(/__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/)?.[1];
  if (!token) {
    throw new Error('gateway 首页未找到 token');
  }
  const ws = new WebSocket(`ws://127.0.0.1:9119/api/ws?token=${token}`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('ws 连接失败'));
  });
  let nextId = 1;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 15000);
      const onMsg = ev => {
        const f = JSON.parse(ev.data);
        if (f.id === id) {
          clearTimeout(timer);
          ws.removeEventListener('message', onMsg);
          if (f.error) {
            reject(new Error(`${method}: ${JSON.stringify(f.error)}`));
          }
          resolve(f.result);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({jsonrpc: '2.0', id, method, params}));
    });
  const sessions = (await call('session.list', {profile: PROFILE, limit: 100}))?.sessions ?? [];
  const profiles = (await call('profiles.list', {}))?.profiles ?? [];
  ws.close();

  const pInfo = profiles.find(p => p.name === PROFILE);
  const nickname =
    pInfo?.ui_meta?.nickname || pInfo?.description || PROFILE;
  console.log(`[期望] ${PROFILE} 昵称 = ${nickname}，共 ${sessions.length} 行`);

  // App 同口径整理：聊天类 + 标题非空且在可见集内唯一（行定位按标题文本）
  const chats = sessions.filter(
    s => !(AUTOMATION_SOURCES.has((s.source || '').trim().toLowerCase())) && (s.title || '').trim(),
  );
  const titleCount = new Map();
  for (const s of chats) {
    titleCount.set(s.title, (titleCount.get(s.title) || 0) + 1);
  }
  const visible = chats.filter(s => titleCount.get(s.title) === 1);
  if (visible.length < 3) {
    throw new Error(`可用于断言的唯一标题行太少：${visible.length}`);
  }
  const recentTitles = visible.map(s => s.title);
  const createdTitles = [...visible]
    .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))
    .map(s => s.title);
  console.log(`[期望] recent 前3：${recentTitles.slice(0, 3).map(t => t.slice(0, 12))}`);
  console.log(`[期望] created 前3：${createdTitles.slice(0, 3).map(t => t.slice(0, 12))}`);
  if (JSON.stringify(recentTitles) === JSON.stringify(createdTitles)) {
    console.log('[警告] 两档期望顺序相同（数据巧合），断言力下降');
  }

  // 2. 浏览器：添加直连配置并连接
  const browser = await chromium.launch({executablePath: EXE, headless: true});
  const page = await browser.newPage({viewport: {width: 900, height: 900}});
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log('[console.error]', msg.text().slice(0, 200));
    }
  });
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));
  await page.goto(VITE, {waitUntil: 'domcontentloaded'});
  await page.waitForTimeout(1500);
  await page.evaluate(() => localStorage.clear()); // 隔离既有配置/排序偏好
  await page.reload({waitUntil: 'domcontentloaded'});
  await page.waitForTimeout(1200);

  await page.getByText('＋ 添加配置').click();
  await page.getByText('连接类型').waitFor({timeout: 5000});
  await page.getByText('直连', {exact: true}).click();
  await page.getByPlaceholder('127.0.0.1').waitFor({timeout: 5000});
  await page.getByPlaceholder('例如：本机 gateway').fill('排序冒烟-直连');
  await page.getByText('保存', {exact: true}).click();
  await page.getByText('排序冒烟-直连').waitFor({timeout: 5000});
  await page.getByText('排序冒烟-直连').click();
  await page.waitForSelector('[aria-label^="打开 profile"]', {timeout: 20000});
  await page.waitForTimeout(1000);

  // 3. 进 main 的会话列表
  await page.locator(`[aria-label="打开 profile ${nickname}"]`).click();
  await page.getByText('最近消息').waitFor({timeout: 10000});
  await page.waitForTimeout(1200); // 等列表拉取渲染

  // 读 UI 行序：每个候选标题取其最内层文本元素的 y 坐标排序
  async function readUiOrder() {
    const ys = [];
    for (const title of recentTitles) {
      const loc = page.getByText(title, {exact: true}).first();
      if ((await loc.count()) === 0) {
        continue;
      }
      const box = await loc.boundingBox();
      if (box) {
        ys.push({title, y: box.y});
      }
    }
    ys.sort((a, b) => a.y - b.y);
    return ys.map(v => v.title);
  }

  // 4. 默认档：行序 = 服务端最近活跃序（未点击过即默认档本身）
  const uiRecent = await readUiOrder();
  if (JSON.stringify(uiRecent) !== JSON.stringify(recentTitles)) {
    console.log('[实际 recent]', uiRecent.slice(0, 5));
    throw new Error('默认档行序 ≠ 服务端最近活跃序');
  }
  await page.screenshot({path: `${OUT}/web-session-sort-1-recent.png`});
  console.log(`OK 默认「最近消息」档：${uiRecent.length} 行与期望一致`);

  // 5. 排序下拉：点药丸开菜单 → 菜单内选「创建时间」
  await page.getByText('最近消息', {exact: true}).click(); // 排序药丸（当前值）
  await page.getByText('创建时间', {exact: true}).waitFor({timeout: 3000}); // 菜单展开
  await page.screenshot({path: `${OUT}/web-session-sort-2b-menu-open.png`});
  await page.getByText('创建时间', {exact: true}).click();
  await page.waitForTimeout(600);
  // 药丸标签切为创建时间；菜单应收起（创建时间只剩药丸一处）
  const sortPillCount = await page.getByText('创建时间', {exact: true}).count();
  if (sortPillCount !== 1) {
    throw new Error(`选完菜单未收起：创建时间 出现 ${sortPillCount} 处`);
  }
  const uiCreated = await readUiOrder();
  if (JSON.stringify(uiCreated) !== JSON.stringify(createdTitles)) {
    console.log('[实际 created]', uiCreated.slice(0, 5));
    throw new Error('「创建时间」档行序 ≠ started_at 降序');
  }
  await page.screenshot({path: `${OUT}/web-session-sort-2-created.png`});
  console.log(`OK 「创建时间」档：${uiCreated.length} 行与期望一致`);

  // 5b. 筛选下拉：切「全部」再切回「聊天」（只验交互与药丸标签）
  await page.getByText('聊天', {exact: true}).click(); // 筛选药丸
  await page.getByText('自动化', {exact: true}).waitFor({timeout: 3000});
  await page.getByText('全部', {exact: true}).click();
  await page.waitForTimeout(400);
  if ((await page.getByText('全部', {exact: true}).count()) !== 1) {
    throw new Error('筛选下拉：选「全部」后菜单未收起');
  }
  await page.getByText('全部', {exact: true}).click();
  await page.getByText('聊天', {exact: true}).waitFor({timeout: 3000});
  await page.getByText('聊天', {exact: true}).click();
  await page.waitForTimeout(400);
  console.log('OK 筛选下拉：全部 ↔ 聊天 切换正常');

  // 6. 持久化落盘
  const stored = await page.evaluate(() =>
    localStorage.getItem('hermes.sessionSort.v1'),
  );
  if (stored !== 'created') {
    throw new Error(`排序偏好未持久化：${stored}`);
  }
  console.log('OK 排序偏好已持久化：hermes.sessionSort.v1 = created');

  // 7. 窄档（<900 单列）排版截图：同上下文缩窗口，配置/偏好已持久化
  await page.setViewportSize({width: 420, height: 800});
  await page.waitForTimeout(1200);
  // 窄档可能回到 profile 首屏：以筛选药丸「聊天」为会话列表哨兵，必要时重新进入
  if ((await page.getByText('聊天', {exact: true}).count()) === 0) {
    await page.locator(`[aria-label="打开 profile ${nickname}"]`).click();
    await page.getByText('聊天', {exact: true}).waitFor({timeout: 10000});
    await page.waitForTimeout(1000);
  }
  await page.screenshot({path: `${OUT}/web-session-sort-3-narrow.png`});
  console.log('OK 窄档（420px）截图完成');

  await browser.close();
  console.log('PASS 会话列表排序档位冒烟全部通过');
}

main().catch(e => {
  console.error('FAIL', e);
  process.exit(1);
});
