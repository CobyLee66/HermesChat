/**
 * desktop-md-copy-smoke.js — 桌面壳（Electron）markdown 复制双入口实测（只读）。
 *
 * 前置：dist-web 与 desktop/dist 已构建（npm run web:build && npm run desktop:build），
 * 本机 hermes 9119 可达。流程：真实 Electron 启动（隔离 userData）→ 添加直连配置 →
 * 连接 → 进第一个 profile → 进第一个会话（只读历史）：
 *  1. 拖选（Selection+Cmd+C）标题块 → 剪贴板得以 # 开头的源码；
 *  2. 右键「复制 Markdown」→ 整条源码；「复制纯文本」→ 渲染后文本。
 */

const fs = require('node:fs');
const path = require('node:path');
const {_electron} = require('playwright-core');

const EXE = path.join(
  __dirname,
  '..',
  'node_modules',
  'electron',
  'dist',
  'Electron.app',
  'Contents',
  'MacOS',
  'Electron',
);
const OUT = 'docs/screenshots';

async function main() {
  // 清空隔离 userData：上次残留的配置卡片会让首页出现隐藏的「直连」标签，
  // 干扰 getByText 定位编辑页分段按钮
  fs.rmSync('/tmp/hermes-desktop-direct-smoke', {recursive: true, force: true});
  const electronApp = await _electron.launch({
    executablePath: EXE,
    args: [path.join(__dirname, '..', 'desktop-smoke-launcher.js')],
  });
  const page = await electronApp.firstWindow();
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));

  await page.waitForSelector('text=Hermes', {timeout: 20000});
  await page.waitForTimeout(1000);

  // 1. 添加直连配置 → 连接
  await page.getByText('＋ 添加配置').click();
  await page.getByText('连接类型').waitFor({timeout: 5000});
  await page
    .getByText('SSH 隧道', {exact: true})
    .locator('xpath=../..')
    .getByText('直连', {exact: true})
    .click();
  await page.getByPlaceholder('127.0.0.1').waitFor({timeout: 5000});
  await page.getByPlaceholder('例如：本机 gateway').fill('桌面复制-测试');
  await page.getByText('保存', {exact: true}).click();
  await page.getByText('桌面复制-测试').waitFor({timeout: 5000});
  await page.getByText('桌面复制-测试').click();
  await page.waitForSelector('[aria-label^="打开 profile"]', {timeout: 20000});
  await page.waitForTimeout(1500);

  // 2. 进第一个 profile → 第一个会话
  await page.locator('[aria-label^="打开 profile"]').first().click();
  await page.waitForTimeout(2500);
  const candidates = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[tabindex]'))
      .filter(r => r.querySelector('img'))
      .map(r => (r.textContent || '').trim().slice(0, 30)),
  );
  console.log('>> tabindex+img 候选:', JSON.stringify(candidates.slice(0, 8)));
  // 会话行特征：含头像 img 且含「M/D HH:MM」时间文本；左栏 profile 竖条无时间
  const firstTitle = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[tabindex]')).filter(
      r =>
        r.querySelector('img') &&
        /\d{1,2}\/\d{1,2} \d{1,2}:\d{2}/.test(r.textContent || ''),
    );
    if (rows.length === 0) {
      return null;
    }
    // 行内第一个非空短文本节点是标题（Avatar 的 img 无文本）
    const titleEl = Array.from(
      rows[0].querySelectorAll('div,span'),
    ).find(
      e =>
        e.children.length === 0 &&
        (e.textContent || '').trim().length > 2 &&
        !/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}/.test(e.textContent),
    );
    return titleEl ? (titleEl.textContent || '').trim() : null;
  });
  console.log('>> 第一个会话标题:', JSON.stringify(firstTitle));
  if (!firstTitle) {
    throw new Error('未找到会话行（含时间的 tabindex+img 容器）');
  }
  await page.getByText(firstTitle, {exact: true}).first().click();
  await page.waitForTimeout(2000);
  await page.waitForSelector('.hm-md [data-md-map]', {timeout: 20000});
  await page.waitForTimeout(1000);
  const blockCount = await page.locator('.hm-md [data-md-map]').count();
  console.log('>> 历史已加载，带源行号的块数:', blockCount);
  await page.screenshot({path: `${OUT}/desktop-mdcopy-1-chat.png`});

  // Electron renderer 默认拒 clipboard-read，读取走主进程（测试侧，不动产品代码）
  const readClip = () =>
    electronApp.evaluate(({clipboard}) => clipboard.readText());

  // 3. 拖选标题块 → Cmd+C → 应得以 # 开头的源码
  const headingSel = await page.evaluate(() => {
    for (const t of ['h1', 'h2', 'h3']) {
      const el = document.querySelector(`.hm-md ${t}[data-md-map]`);
      if (el) {
        return `.hm-md ${t}[data-md-map="${el.getAttribute('data-md-map')}"]`;
      }
    }
    return null;
  });
  if (!headingSel) {
    throw new Error('该会话历史无标题块，换一个会话或补充断言');
  }
  await page.evaluate(sel => {
    const el = document.querySelector(sel);
    const range = document.createRange();
    range.selectNodeContents(el);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
  }, headingSel);
  await page.keyboard.press('ControlOrMeta+c');
  const copied = await readClip();
  console.log('>> 标题块复制结果:', JSON.stringify(copied.slice(0, 60)));
  if (!/^#{1,6} /.test(copied)) {
    throw new Error(`标题块复制未得到 # 源码: ${JSON.stringify(copied.slice(0, 80))}`);
  }
  console.log('PASS 1: 拖选标题块 → Cmd+C 得到以 # 开头的 Markdown 源码');

  // 3b. 真实鼠标拖选标题块部分文字 → Cmd+C → 源码（程序化 Selection 会绕过
  //     RNW Touchable 对拖选的阻止，必须补真实鼠标路径）
  await page.evaluate(() => window.getSelection().removeAllRanges());
  const vh = await page.evaluate(() => {
    for (const t of ['h1', 'h2', 'h3']) {
      const el = document.querySelector(`.hm-md ${t}`);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.y >= 0 && r.y + r.height <= window.innerHeight) {
          return {x: r.x, y: r.y, w: r.width, h: r.height};
        }
      }
    }
    return null;
  });
  if (vh) {
    await page.mouse.move(vh.x + 10, vh.y + vh.h / 2);
    await page.mouse.down();
    await page.mouse.move(vh.x + Math.min(60, vh.w - 5), vh.y + vh.h / 2, {
      steps: 6,
    });
    await page.mouse.up();
    const dragSelLen = await page.evaluate(
      () => String(window.getSelection()).length,
    );
    if (dragSelLen === 0) {
      throw new Error('真实鼠标拖选未产生选区（RNW Touchable 阻止拖选回归？）');
    }
    await page.keyboard.press('ControlOrMeta+c');
    const dragCopied = await readClip();
    if (!/^#{1,6} /.test(dragCopied)) {
      throw new Error(
        `真实拖选复制未得到 # 源码: ${JSON.stringify(dragCopied.slice(0, 60))}`,
      );
    }
    console.log(
      `PASS 1b: 真实鼠标拖选（${dragSelLen} 字）→ Cmd+C 得到 ${JSON.stringify(dragCopied.slice(0, 24))}…`,
    );
  } else {
    console.log('SKIP 1b: 视口内无标题块');
  }

  // 4. 右键「复制 Markdown」→ 整条源码
  await page.evaluate(() => window.getSelection().removeAllRanges());
  const box = await page.locator('.hm-md').first().boundingBox();
  await page.mouse.click(box.x + 40, box.y + 12, {button: 'right'});
  await page.getByText('复制 Markdown', {exact: true}).waitFor({timeout: 5000});
  await page.screenshot({path: `${OUT}/desktop-mdcopy-2-context-menu.png`});
  await page.getByText('复制 Markdown', {exact: true}).click();
  await page.waitForTimeout(400);
  const wholeMenu = await readClip();
  if (!wholeMenu.trim()) {
    throw new Error('右键「复制 Markdown」剪贴板为空');
  }

  // 5. 右键「复制纯文本」→ 渲染后文本（与源码不同的证据：无 # 行首语法）
  await page.mouse.click(box.x + 40, box.y + 12, {button: 'right'});
  await page.getByText('复制纯文本', {exact: true}).waitFor({timeout: 5000});
  await page.getByText('复制纯文本', {exact: true}).click();
  await page.waitForTimeout(400);
  const plain = await readClip();
  if (!plain.trim()) {
    throw new Error('「复制纯文本」剪贴板为空');
  }
  if (/^#{1,6} /m.test(wholeMenu) && /^#{1,6} /m.test(plain)) {
    throw new Error('「复制纯文本」仍含 # 标题语法，未取渲染后文本');
  }
  console.log(
    `PASS 2: 右键双项通过（Markdown ${wholeMenu.trim().length} 字；纯文本 ${plain.trim().length} 字）`,
  );

  console.log('OK Electron 桌面 markdown 复制双入口全部通过');
  await electronApp.close();
}

main().catch(e => {
  console.error('[FAIL]', e.message);
  process.exit(1);
});
