/**
 * ModelPicker 加载守卫（流式期间弹窗失灵/崩溃修复）：
 * - 打开弹窗只加载一次：父级在流式期间高频重渲染会不断产生新内联 load
 *   引用，组件必须只在 visible 置 true 时触发加载（此前 useEffect 依赖
 *   [visible, load]，每个 delta 重发 model.options + config.get 两个 RPC，
 *   model.options 服务端为秒级长任务，风暴下必超时 → 弹窗卡死）；
 * - 关闭再打开重新加载；
 * - 代次守卫：旧请求在关闭/重载后才 resolve 不得覆写最新状态。
 */

import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';

import {ModelPicker, type ModelPickerData} from '../src/components/ModelPicker';

const DATA: ModelPickerData = {
  models: {
    providers: [
      {slug: 'anthropic', name: 'Anthropic', is_current: true, models: ['m1', 'm2']},
    ],
    model: 'm1',
    provider: 'anthropic',
  },
  reasoning: 'medium',
};

function render(visible: boolean, load: () => Promise<ModelPickerData>) {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <ModelPicker
        visible={visible}
        onClose={() => {}}
        load={load}
        onPick={() => {}}
        onPickReasoning={() => {}}
      />,
    );
  });
  return tree;
}

/** 让 pending 的 load promise 链走完（then/catch/finally 均在微任务里）。 */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ModelPicker 加载守卫', () => {
  it('打开弹窗只加载一次，resolve 后渲染模型行', async () => {
    const load = jest.fn(() => Promise.resolve(DATA));
    const tree = render(true, load);
    expect(load).toHaveBeenCalledTimes(1);
    await flush();
    const texts = JSON.stringify(tree.toJSON());
    expect(texts).toContain('m1');
    expect(texts).toContain('Anthropic');
  });

  it('流式模拟：visible 期间反复以新内联 load 引用 rerender，不重新加载', async () => {
    const load = jest.fn(() => Promise.resolve(DATA));
    const tree = render(true, load);
    await flush();
    // 父级每 delta 重渲染 → 每次渲染都是新箭头函数（修复前每个都重触发加载）
    for (let i = 0; i < 5; i++) {
      act(() => {
        tree.update(
          <ModelPicker
            visible={true}
            onClose={() => {}}
            load={() => Promise.resolve(DATA)}
            onPick={() => {}}
            onPickReasoning={() => {}}
          />,
        );
      });
    }
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('关闭再打开重新加载', async () => {
    const load = jest.fn(() => Promise.resolve(DATA));
    const tree = render(true, load);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    act(() => {
      tree.update(
        <ModelPicker
          visible={false}
          onClose={() => {}}
          load={load}
          onPick={() => {}}
          onPickReasoning={() => {}}
        />,
      );
    });
    act(() => {
      tree.update(
        <ModelPicker
          visible={true}
          onClose={() => {}}
          load={load}
          onPick={() => {}}
          onPickReasoning={() => {}}
        />,
      );
    });
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('代次守卫：旧请求在关闭后才 resolve，不覆写重开后的新数据', async () => {
    let resolveStale!: (d: ModelPickerData) => void;
    const staleLoad = jest.fn(
      () => new Promise<ModelPickerData>(res => (resolveStale = res)),
    );
    const tree = render(true, staleLoad);
    // 未 resolve 时关闭弹窗（本次加载作废）
    act(() => {
      tree.update(
        <ModelPicker
          visible={false}
          onClose={() => {}}
          load={staleLoad}
          onPick={() => {}}
          onPickReasoning={() => {}}
        />,
      );
    });
    // 重开：新 load 返回不同模型列表
    const fresh: ModelPickerData = {
      models: {
        providers: [
          {slug: 'openai', name: 'OpenAI', is_current: true, models: ['fresh-m']},
        ],
        model: 'fresh-m',
        provider: 'openai',
      },
      reasoning: 'high',
    };
    const freshLoad = jest.fn(() => Promise.resolve(fresh));
    act(() => {
      tree.update(
        <ModelPicker
          visible={true}
          onClose={() => {}}
          load={freshLoad}
          onPick={() => {}}
          onPickReasoning={() => {}}
        />,
      );
    });
    await flush();
    // 旧请求此刻才 resolve —— 不得把过期数据盖回去
    const stale: ModelPickerData = {
      models: {
        providers: [
          {slug: 'old', name: 'Old', is_current: true, models: ['stale-m']},
        ],
        model: 'stale-m',
        provider: 'old',
      },
      reasoning: 'low',
    };
    act(() => {
      resolveStale(stale);
    });
    await flush();
    const texts = JSON.stringify(tree.toJSON());
    expect(texts).toContain('fresh-m');
    expect(texts).not.toContain('stale-m');
  });
});
