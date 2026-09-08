/**
 * 桌面直连冒烟 launcher：必须放项目根目录（Electron 以 args[0] 所在目录为
 * app 路径，STATIC_ROOT = <appPath>/dist-web），加载前隔离 userData，
 * 不碰用户真实数据。HERMES_SMOKE_USER_DATA 可指定隔离目录（默认见下）。
 */
const path = require('node:path');
const {app} = require('electron');

app.setPath(
  'userData',
  process.env.HERMES_SMOKE_USER_DATA || '/tmp/hermes-desktop-direct-smoke',
);
require(path.join(__dirname, 'desktop', 'dist', 'main.js'));
