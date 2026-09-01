/**
 * 冒烟测试：纯逻辑单元（主题取色 / token 提取 / Transport 类型）。
 * App 组件依赖 react-navigation 原生模块，渲染级验证交给真机构建。
 */

import {avatarColor, Colors} from '../src/components/theme';
import {extractToken} from '../src/ssh/transport';

test('avatarColor 稳定且在调色板内', () => {
  const c1 = avatarColor('示例 agent');
  const c2 = avatarColor('示例 agent');
  expect(c1).toBe(c2);
  expect(c1).toMatch(/^#[0-9A-F]{6}$/i);
  expect(avatarColor('')).toMatch(/^#[0-9A-F]{6}$/i);
});

test('extractToken 从 SPA HTML 提取 token', () => {
  expect(
    extractToken('<script>window.__HERMES_SESSION_TOKEN__="abc123";</script>'),
  ).toBe('abc123');
  expect(extractToken('<html>no token</html>')).toBeNull();
});

test('主题色定义完整', () => {
  expect(Colors.accent).toBeDefined();
  expect(Colors.bg).toBeDefined();
  expect(Colors.danger).toBeDefined();
});
