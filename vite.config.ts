/**
 * vite 配置（仅 web 本地调试，`npm run web`；Metro/原生构建不读此文件）。
 *
 * - `react-native` → `react-native-web`；原生模块 alias 到 src/web-stubs/ 打桩。
 * - `.web.*` 扩展名优先（react-native-screens / native-stack 自带 web 实现）。
 * - server.proxy：浏览器直连本机 dashboard（127.0.0.1:9119）。
 *   hermes web_server 对 WS upgrade 有 Host/Origin 防护（_ws_host_origin_reason），
 *   这里 changeOrigin 重写 Host、headers 重写 Origin 为绑定地址，两条检查都过。
 *   - /api/**（含 /api/ws 的 WS upgrade）→ 9119
 *   - /__hermes/** → 9119 去前缀（取 SPA HTML 提取 __HERMES_SESSION_TOKEN__）
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
      './HermesSsh': r('./src/web-stubs/HermesSsh.ts'),
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
