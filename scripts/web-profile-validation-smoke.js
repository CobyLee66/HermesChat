/**
 * web-profile-validation-smoke.js — 连接配置编辑页冒烟（Playwright，纯 UI 验证，不连任何服务）。
 *
 * 前置：`npx vite` 已运行（localhost:5188）。流程：
 * 1. 新建 SSH 配置页：placeholder 为次要灰 rgb(138,143,153)（Colors.textSecondary），
 *    与输入正文色（Colors.text 深色）区分；
 * 2. 清空端口后空表单点保存：window.alert 弹出 4 条错误；host/port/username/password
 *    红边框（Colors.danger）+ 字段下方红字；
 * 3. 输入即清错：host/port 填回后对应红框/红字消失；
 * 4. 补全合法配置保存成功 → 返回列表出现卡片；
 * 5. 直连类型：host/port 已代填默认值，无用户名/凭据也能保存（不校验）。
 *
 * 用法：node scripts/web-profile-validation-smoke.js
 */

const fs = require('node:fs');
const {chromium} = require('playwright-core');

// Chromium 路径由 playwright-core 按自身版本解析，缺失时先跑：
// npx playwright-core install chromium
const EXE = chromium.executablePath();
if (!fs.existsSync(EXE)) {
  console.error(`未找到 Chromium：${EXE}`);
  console.error('请先安装：npx playwright-core install chromium');
  process.exit(1);
}
const BASE = 'http://localhost:5188/';
const OUT = 'docs/screenshots';
const GRAY = 'rgb(138, 143, 153)'; // Colors.textSecondary
const RED = 'rgb(245, 63, 63)'; // Colors.danger

function fail(msg) {
  console.error(`FAIL ${msg}`);
  process.exitCode = 1;
}

async function placeholderColor(page, placeholder) {
  const el = page.getByPlaceholder(placeholder);
  return el.evaluate(e => getComputedStyle(e, '::placeholder').color);
}

async function borderColor(page, placeholder) {
  const el = page.getByPlaceholder(placeholder);
  return el.evaluate(e => getComputedStyle(e).borderTopColor);
}

async function main() {
  const browser = await chromium.launch({executablePath: EXE, headless: true});
  const page = await browser.newPage({viewport: {width: 900, height: 900}});
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
  const alerts = [];
  page.on('dialog', async d => {
    alerts.push(d.message());
    await d.accept();
  });

  await page.goto(BASE, {waitUntil: 'domcontentloaded'});
  await page.getByText('＋ 添加配置').click();
  await page.getByText('连接类型').waitFor({timeout: 5000});

  // 1. placeholder 灰色（SSH 表单全部占位示例）
  const placeholders = [
    '例如 192.168.1.10',
    '22',
    '例如 root',
    '使用私钥时可留空',
    '粘贴 PEM 内容，或点上方按钮选择文件',
  ];
  for (const p of placeholders) {
    const c = await placeholderColor(page, p);
    if (c !== GRAY) {
      fail(`placeholder「${p}」颜色=${c}，期望 ${GRAY}`);
    }
  }
  console.log('PASS placeholder 全部为次要灰');
  await page.screenshot({path: `${OUT}/web-profile-validation-1-placeholders.png`});

  // 2. 清空端口（默认预填 22，先制造端口错误）→ 空表单保存：弹窗 4 条错误 + 红框红字
  await page.getByPlaceholder('22').fill('');
  await page.getByText('保存', {exact: true}).click();
  await page
    .getByText('请填写 SSH 主机地址', {exact: true})
    .waitFor({timeout: 5000});
  if (alerts.length !== 1) {
    fail(`保存应弹一次错误提示，实际 ${alerts.length} 次`);
  } else {
    const msg = alerts[0];
    for (const expect of [
      '无法保存',
      '请填写 SSH 主机地址',
      '请填写端口',
      '请填写 SSH 用户名',
      '密码与私钥至少填写一项',
    ]) {
      if (!msg.includes(expect)) {
        fail(`弹窗缺少「${expect}」：${JSON.stringify(msg)}`);
      }
    }
  }
  for (const [p, key] of [
    ['例如 192.168.1.10', 'host'],
    ['22', 'port'],
    ['例如 root', 'username'],
    ['使用私钥时可留空', 'auth'],
  ]) {
    const c = await borderColor(page, p);
    if (c !== RED) {
      fail(`${key} 输入框边框=${c}，期望红 ${RED}`);
    }
  }
  console.log('PASS 空表单保存：弹窗 4 条错误 + 出错字段红边框/红字');
  await page.screenshot({path: `${OUT}/web-profile-validation-2-errors.png`});

  // 3. 输入即清错
  await page.getByPlaceholder('例如 192.168.1.10').fill('10.0.0.9');
  const hostErrLeft = await page
    .getByText('请填写 SSH 主机地址', {exact: true})
    .count();
  if (hostErrLeft !== 0) {
    fail('host 填入后错误红字未消失');
  }
  if ((await borderColor(page, '例如 192.168.1.10')) === RED) {
    fail('host 填入后红边框未恢复');
  }
  await page.getByPlaceholder('22').fill('22');
  const portErrLeft = await page
    .getByText('请填写端口', {exact: true})
    .count();
  if (portErrLeft !== 0) {
    fail('port 填入后错误红字未消失');
  }
  console.log('PASS 重新输入后该字段错误即时清除');

  // 4. 补全合法配置 → 保存成功回列表
  await page.getByPlaceholder('例如 root').fill('root');
  await page.getByPlaceholder('使用私钥时可留空').fill('secret');
  await page.getByText('保存', {exact: true}).click();
  await page.getByText('10.0.0.9', {exact: true}).waitFor({timeout: 5000});
  console.log('PASS 合法配置保存成功，列表出现卡片');

  // 5. 直连类型不校验用户名/凭据
  await page.getByText('＋ 添加配置').click();
  await page.getByText('连接类型').waitFor({timeout: 5000});
  await page.getByText('直连', {exact: true}).click();
  await page.getByPlaceholder('127.0.0.1').waitFor({timeout: 5000});
  await page.getByText('保存', {exact: true}).click();
  await page.getByText('127.0.0.1', {exact: true}).waitFor({timeout: 5000});
  if (alerts.length !== 1) {
    fail(`直连保存不应再弹错误提示，累计弹窗 ${alerts.length} 次`);
  } else {
    console.log('PASS 直连类型无需用户名/凭据即可保存');
  }

  await browser.close();
  console.log(process.exitCode ? '冒烟未全过' : '全部 PASS');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
