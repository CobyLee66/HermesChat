#!/usr/bin/env node
/**
 * i18n-check — 界面多语言守护脚本（零依赖，CI 第 4 步 + 本地自查）。
 *
 * 三项检查：
 * 1. 词典键对齐：en.ts 与 zh-CN.ts 登记的键集合必须一致（tsc 类型已强制，
 *    这里给非编译期场景兜底 + 友好报告）；
 * 2. 硬编码文案扫描：src/ 与 desktop/ 的 *.ts(x) 字符串字面量中出现 CJK
 *    字符即报错（剥离注释、豁免 dlog/appendLog/console 诊断日志、白名单
 *    目录）；新增 UI 文案必须走 src/i18n t()（desktop 主进程走 desktop/i18n
 *    dt()），禁止绕过；
 * 3. 未使用键报告：词典中登记但代码里无 t('key') 引用的键（仅报告不拦截）。
 *
 * 用法：node scripts/i18n-check.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EN_FILE = path.join(ROOT, 'src', 'i18n', 'locales', 'en.ts');
const ZH_FILE = path.join(ROOT, 'src', 'i18n', 'locales', 'zh-CN.ts');

/** 硬编码扫描根目录（相对仓库根）。 */
const SCAN_ROOTS = ['src', 'desktop'];
/** 扫描排除目录（目录前缀，相对仓库根）：词典本体/开发替身，不面向终端用户。 */
const SCAN_EXCLUDE_DIRS = [
  'src/i18n/locales',
  'src/web-stubs',
  'desktop/dist',
];
/** 扫描排除文件。 */
const SCAN_EXCLUDE_FILES = ['desktop/i18n.ts'];
/** 测试文件不参与硬编码扫描（测试断言里出现中文属正常）。 */
const SCAN_EXCLUDE_TEST_RE = /\.test\.(ts|tsx)$/;
/**
 * 未使用键白名单：动态拼键等静态分析够不到的键在此登记（附原因）。
 * 目前无此类键。
 */
const WHITELIST_UNUSED = new Set([]);

let failed = false;

// ─── 1. 词典键对齐 ──────────────────────────────────────────────

/** 从词典 TS 文件提取键（行首 `'xxx':` 形态）。 */
function extractKeys(file) {
  const keys = new Set();
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*'((?:[^'\\]|\\.)+)':/);
    if (m) {
      keys.add(m[1]);
    }
  }
  return keys;
}

const enKeys = extractKeys(EN_FILE);
const zhKeys = extractKeys(ZH_FILE);

const missingInZh = [...enKeys].filter(k => !zhKeys.has(k));
const missingInEn = [...zhKeys].filter(k => !enKeys.has(k));
if (missingInZh.length > 0 || missingInEn.length > 0) {
  failed = true;
  if (missingInZh.length > 0) {
    console.error(`[keys] zh-CN.ts 缺少 ${missingInZh.length} 个键：`);
    for (const k of missingInZh) {
      console.error(`  - ${k}`);
    }
  }
  if (missingInEn.length > 0) {
    console.error(`[keys] zh-CN.ts 多出 ${missingInEn.length} 个键（en.ts 无）：`);
    for (const k of missingInEn) {
      console.error(`  - ${k}`);
    }
  }
} else {
  console.log(`[keys] 对齐 ✓（${enKeys.size} 个键，en/zh-CN 两表一致）`);
}

// ─── 2. 硬编码 CJK 字符串扫描 ───────────────────────────────────

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

function isExcluded(rel) {
  if (SCAN_EXCLUDE_FILES.includes(rel)) {
    return true;
  }
  if (SCAN_EXCLUDE_TEST_RE.test(rel)) {
    return true;
  }
  return SCAN_EXCLUDE_DIRS.some(
    p => rel === p || rel.startsWith(`${p}/`),
  );
}

/** 列出待扫描文件。 */
function listSourceFiles(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      if (!isExcluded(rel)) {
        listSourceFiles(full, out);
      }
    } else if (/\.(ts|tsx)$/.test(name) && !isExcluded(rel)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 硬编码中文检测：剥掉注释、豁免日志调用（含跨行）后，行内出现任何 CJK
 * 即违规——既覆盖字符串字面量（应改 t()），也覆盖 JSX 标签间文本（第一版
 * 只查引号内字符串，漏掉了 `<Text>退出连接</Text>` 这类 JSX 文本）。
 * 模板串/拼接里的中文一样要 t() 化，宁严勿漏，少量误报人工确认。
 */
const LOG_CALL_RE = /\b(dlog|appendLog|console\.(log|warn|error|info))\s*\(/;

/** ASCII 括号净值（近似：忽略字符串内容里的括号，中文全角括号不计数）。 */
function netParens(code) {
  let depth = 0;
  for (const ch of code) {
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
    }
  }
  return depth;
}

function findHardcoded(file) {
  const hits = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let inBlockComment = false;
  // 跨行日志调用剩余括号深度（>0 表示正处在 dlog/appendLog 调用内）
  let logParenDepth = 0;
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    // 块注释状态机：/** ... */ 头注释与行内延续行
    if (inBlockComment) {
      if (trimmed.includes('*/')) {
        inBlockComment = false;
      }
      return;
    }
    if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('{/*')) {
      if (
        (trimmed.startsWith('/*') || trimmed.startsWith('{/*')) &&
        !trimmed.includes('*/')
      ) {
        inBlockComment = true;
      }
      return;
    }
    let code = line;
    const commentIdx = code.indexOf('//');
    if (commentIdx >= 0) {
      code = code.slice(0, commentIdx);
    }
    // 日志调用起始行（无论该行有无 CJK 都要先登记，后续延续行才可豁免）
    if (LOG_CALL_RE.test(code)) {
      if (logParenDepth <= 0) {
        const depth = netParens(code);
        if (depth > 0) {
          logParenDepth = depth;
        }
      }
      return;
    }
    // 跨行日志调用延续行：随括号闭合递减，闭合前整行豁免
    if (logParenDepth > 0) {
      logParenDepth += netParens(code);
      return;
    }
    if (CJK_RE.test(code)) {
      hits.push({line: i + 1, text: line.trim().slice(0, 100)});
    }
  });
  return hits;
}

const hardcoded = [];
for (const root of SCAN_ROOTS) {
  const rootDir = path.join(ROOT, root);
  if (!fs.existsSync(rootDir)) {
    continue;
  }
  for (const file of listSourceFiles(rootDir)) {
    for (const hit of findHardcoded(file)) {
      hardcoded.push({file: path.relative(ROOT, file), ...hit});
    }
  }
}
if (hardcoded.length > 0) {
  failed = true;
  console.error(`\n[hardcode] 发现 ${hardcoded.length} 处疑似硬编码中文文案（必须改走 i18n 取词）：`);
  for (const h of hardcoded) {
    console.error(`  ${h.file}:${h.line}  ${h.text}`);
  }
  console.error('\n如确属诊断日志，改用 dlog()/appendLog()；如属词典/桩文件，登记脚本白名单。');
} else {
  console.log('[hardcode] 无硬编码中文文案 ✓');
}

// ─── 3. 未使用键（仅报告） ──────────────────────────────────────

const usageParts = [];
function collectForUsage(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      collectForUsage(full);
    } else if (/\.(ts|tsx)$/.test(name)) {
      usageParts.push(fs.readFileSync(full, 'utf8'));
    }
  }
}
collectForUsage(path.join(ROOT, 'src'));
try {
  usageParts.push(fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8'));
} catch {
  // ignore
}
const usageBlob = usageParts.join('\n');

const unused = [...enKeys].filter(
  k => !WHITELIST_UNUSED.has(k) && !usageBlob.includes(`'${k}'`),
);
if (unused.length > 0) {
  console.log(`\n[unused] ${unused.length} 个键在代码中未见直接引用（仅报告，不拦截）：`);
  for (const k of unused) {
    console.log(`  - ${k}`);
  }
} else {
  console.log('[unused] 无未使用键 ✓');
}

console.log('');
if (failed) {
  console.error('i18n-check：未通过（键对齐 / 硬编码扫描见上）。');
  process.exit(1);
}
console.log('i18n-check：通过 ✓');
