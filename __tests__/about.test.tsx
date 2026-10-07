/**
 * AboutPanel：应用名 / 版本号 / 简介渲染，三条外链 + 许可证按压以正确 URL
 * 调 openExternalUrl（jest setup 全局钉 zh-CN）。
 */
import React from 'react';
import {Text, TouchableOpacity} from 'react-native';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';

import {AboutPanel} from '../src/panels/AboutPanel';
import {
  APP_VERSION,
  GITHUB_ISSUES_URL,
  GITHUB_LICENSE_URL,
  GITHUB_RELEASES_URL,
  GITHUB_REPO_URL,
} from '../src/constants';
import {openExternalUrl} from '../src/utils/openExternalUrl';

jest.mock('../src/utils/openExternalUrl', () => ({
  openExternalUrl: jest.fn(() => Promise.resolve()),
}));

const mockedOpen = openExternalUrl as jest.Mock;

function render() {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<AboutPanel />);
  });
  return tree;
}

function joined(tree: ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(n => n.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join('');
}

describe('AboutPanel', () => {
  beforeEach(() => {
    mockedOpen.mockClear();
  });

  it('渲染应用名、版本号与简介', () => {
    const tree = render();
    const text = joined(tree);
    expect(text).toContain('HermesChat');
    expect(text).toContain(`版本 ${APP_VERSION}`);
    expect(text).toContain('Hermes Agent 的手机与桌面客户端');
  });

  it('三条链接与许可证按压以对应 URL 打开', () => {
    const tree = render();
    // 顺序：GitHub 仓库 / 发布页 / 反馈问题 / 许可证
    const btns = tree.root.findAllByType(TouchableOpacity);
    expect(btns).toHaveLength(4);
    const cases: Array<[unknown, string]> = [
      [btns[0], GITHUB_REPO_URL],
      [btns[1], GITHUB_RELEASES_URL],
      [btns[2], GITHUB_ISSUES_URL],
      [btns[3], GITHUB_LICENSE_URL],
    ];
    for (const [btn, url] of cases) {
      act(() => (btn as {props: {onPress: () => void}}).props.onPress());
      expect(mockedOpen).toHaveBeenCalledWith(url);
    }
    expect(mockedOpen).toHaveBeenCalledTimes(4);
  });

  it('链接打开失败不抛出（alertError 兜底）', async () => {
    mockedOpen.mockRejectedValueOnce(new Error('no browser'));
    const tree = render();
    await act(async () => {
      tree.root
        .findAllByType(TouchableOpacity)[0]
        .props.onPress();
    });
    expect(mockedOpen).toHaveBeenCalledTimes(1);
  });

  it('版本号与仓库链接常量配置正确', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(GITHUB_REPO_URL).toBe('https://github.com/CobyLee66/HermesChat');
  });
});
