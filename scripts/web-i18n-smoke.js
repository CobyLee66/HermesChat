/**
 * web-i18n-smoke.js — 界面多语言冒烟（Playwright，纯 UI 验证，不连任何服务）。
 *
 * 前置：`npx vite` 已运行（localhost:5188）。
 *
 * 验证链路：系统语言检测（navigator.language）→ resolveLocale 归一 →
 * localStorage（hermes.locale.v1）手动覆盖 → 词典渲染。以连接主页副标题
 * 文案为观测点（zh: 选择配置… / en: Pick a profile…）：
 *   1. auto + 英文系统（locale: en-US）→ 英文界面；
 *   2. auto + 中文系统（locale: zh-CN）→ 中文界面；
 *   3. 手动覆盖存储 en + 中文系统 → 英文界面（覆盖优先于系统）；
 *   4. 存储非法值 fr + 中文系统 → 忽略存储，中文界面（不支持的语言走系统）。
 *
 * 语言切换组件（LanguageToggle）挂在连接后的列表页/桌面栏，纯浏览器无网关
 * 进不去，本冒烟不覆盖（setMode 持久化由 __tests__/i18n.test.ts 覆盖）。
 *
 * 用法：node scripts/web-i18n-smoke.js
 */

const fs = require('node:fs');
const {chromium} = require('playwright-core');

const EXE = chromium.executablePath();
if (!fs.existsSync(EXE)) {
  console.error(`未找到 Chromium：${EXE}`);
  console.error('请先安装：npx playwright-core install chromium');
  process.exit(1);
}
const BASE = 'http://localhost:5188/';
const LOCALE_KEY = 'hermes.locale.v1';
const EN_MARK = 'Pick a profile to connect to your Hermes Agent';
const ZH_MARK = '选择配置，连接到你的 Hermes Agent';

async function visibleText(page, mark) {
  try {
    await page.waitForSelector(`text=${mark}`, {timeout: 5000});
    return true;
  } catch {
    return false;
  }
}

async function scenario(name, expectEn, setup) {
  const browser = await chromium.launch({executablePath: EXE});
  try {
    const context = await browser.newContext({locale: setup.locale});
    const page = await context.newPage();
    if (setup.storage) {
      await page.goto(BASE);
      await page.evaluate(
        ([k, v]) => localStorage.setItem(k, v),
        [LOCALE_KEY, setup.storage],
      );
    }
    await page.goto(BASE);
    const en = await visibleText(page, EN_MARK);
    const zh = await visibleText(page, ZH_MARK);
    await context.close();
    const ok = expectEn ? (en && !zh) : (zh && !en);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}（en=${en} zh=${zh}）`);
    return ok;
  } finally {
    await browser.close();
  }
}

(async () => {
  const results = [];
  results.push(
    await scenario('1. auto + 英文系统 → 英文', true, {locale: 'en-US'}),
  );
  results.push(
    await scenario('2. auto + 中文系统 → 中文', false, {locale: 'zh-CN'}),
  );
  results.push(
    await scenario('3. 覆盖存 en + 中文系统 → 英文', true, {
      locale: 'zh-CN',
      storage: 'en',
    }),
  );
  results.push(
    await scenario('4. 存非法 fr + 中文系统 → 中文', false, {
      locale: 'zh-CN',
      storage: 'fr',
    }),
  );
  if (results.some(ok => !ok)) {
    process.exit(1);
  }
  console.log('全部 PASS');
})();
