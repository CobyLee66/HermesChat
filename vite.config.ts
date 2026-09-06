/**
 * vite 配置（web 构建：`npm run web` 浏览器调试 / `npm run web:build` 桌面产物；
 * Metro/原生构建不读此文件）。
 *
 * - `react-native` → `react-native-web`；原生模块 alias 打桩。
 *   './HermesSsh' → desktopHermesSsh：Electron 桌面下委托 window.hermesDesktop
 *   （主进程 ssh2），普通浏览器无桥时全部 reject（原 web 打桩语义）。
 * - `.web.*` 扩展名优先（react-native-screens / native-stack 自带 web 实现）。
 * - server.proxy：浏览器直连本机 dashboard（127.0.0.1:9119）。
 *   hermes web_server 对 WS upgrade 有 Host/Origin 防护（_ws_host_origin_reason），
 *   这里 changeOrigin 重写 Host、headers 重写 Origin 为绑定地址，两条检查都过。
 *   桌面构建不经此 proxy——Electron 主进程回环代理复用同一重写策略
 *   （见 desktop/main.ts）。
 *   - /api/**（含 /api/ws 的 WS upgrade）→ 9119
 *   - /__hermes/** → 9119 去前缀（取 SPA HTML 提取 __HERMES_SESSION_TOKEN__）
 * - build：产物 dist-web/，供 Electron 静态服务（desktop/main.ts）。
 */

import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const DASHBOARD = 'http://127.0.0.1:9119';

export default defineConfig({
  root: 'web',
  resolve: {
    extensions: [
      '.web.tsx',
      '.web.ts',
      '.web.jsx',
      '.web.js',
      '.tsx',
      '.ts',
      '.jsx',
      '.js',
      '.json',
    ],
    alias: {
      'react-native': 'react-native-web',
      './HermesSsh': r('./src/ssh/desktopHermesSsh.ts'),
      'react-native-fs': r('./src/web-stubs/react-native-fs.ts'),
      '@react-native-documents/picker': r('./src/web-stubs/documents-picker.ts'),
      '@react-native-async-storage/async-storage': r(
        './src/web-stubs/async-storage.ts',
      ),
      '@bam.tech/react-native-image-resizer': r(
        './src/web-stubs/image-resizer.ts',
      ),
    },
  },
  // 依赖预打包（rolldown optimizer）不走 resolve.extensions 的 .web.js 优先，
  // 会把 screens/safe-area-context 的原生路径（react-native/Libraries/* 深引用）
  // 打进去，故这两个包排除出预打包，交给 dev transform 管线（.web.js 生效）。
  // 其余包（@react-navigation 等）保持预打包，避免 CJS 裸文件 interop 问题。
  optimizeDeps: {
    exclude: ['react-native-screens', 'react-native-safe-area-context'],
    // 被排除包的 CJS 依赖需显式拉回预打包，否则裸 CJS 直出没有 default interop
    include: ['warn-once'],
  },
  build: {
    // 桌面产物：Electron 主进程回环代理静态服务（desktop/main.ts）
    outDir: '../dist-web',
    emptyOutDir: true,
  },
  server: {
    port: 5188,
    proxy: {      '/api': {
        target: DASHBOARD,
        changeOrigin: true,
        ws: true,
        headers: {origin: DASHBOARD},
      },
      '/__hermes': {
        target: DASHBOARD,
        changeOrigin: true,
        rewrite: p => p.replace(/^\/__hermes/, '') || '/',
        headers: {origin: DASHBOARD},
      },
    },
  },
});
