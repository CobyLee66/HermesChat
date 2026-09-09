/**
 * cron store 测试：
 * - refresh：成功落 jobs/loaded；失败落 error（非 silent）
 * - cron.changed 事件：防抖后静默刷新；本会话未加载过不刷；同一 RPC 只接线一次
 * - pause/trigger/remove：REST 参数、行级 busy/triggering 状态清理、动作后静默刷新
 * - isCronConflict：409 判定
 *
 * jest.mock 工厂必须自包含（babel-jest-hoist 禁止工厂引用外层变量——本工具链
 * 会把外层引用静默绑成 undefined），mock 实例挂在被 mock 模块的 __mocks 上取回。
 */

import {useConnectionStore} from '../src/store/connection';
import {
  _resetCronEventWiring,
  isCronConflict,
  useCronStore,
} from '../src/store/cron';
import type {CronJob} from '../src/rpc/types';

jest.mock('../src/rpc/runtime', () => {
  const on = jest.fn();
  return {getRpc: () => ({on}), __mockOn: on};
});

jest.mock('../src/rpc/cron', () => {
  const actual = jest.requireActual<typeof import('../src/rpc/cron')>(
    '../src/rpc/cron',
  );
  const list = jest.fn();
  const pause = jest.fn();
  const resume = jest.fn();
  const run = jest.fn();
  const del = jest.fn();
  return {
    CronHttpError: actual.CronHttpError,
    listCronJobs: list,
    pauseCronJob: pause,
    resumeCronJob: resume,
    triggerCronJob: run,
    deleteCronJob: del,
    getDeliveryTargets: jest.fn(),
    __mocks: {list, pause, resume, run, del},
  };
});

const runtime = jest.requireMock('../src/rpc/runtime') as {
  getRpc: () => {on: jest.Mock};
  __mockOn: jest.Mock;
};
const cronApi = jest.requireMock('../src/rpc/cron') as {
  __mocks: {list: jest.Mock; pause: jest.Mock; resume: jest.Mock; run: jest.Mock; del: jest.Mock};
};
// resetAllMocks 会把 mock 模块顶层导出属性清成 undefined，mock 实例一律经 __mocks 取
const {list, pause, run, del} = cronApi.__mocks;

function job(id: string, over: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: `任务-${id}`,
    prompt: '做点事',
    enabled: true,
    state: 'scheduled',
    deliver: 'local',
    profile: 'default',
    ...over,
  };
}

/** 等微任务清空（store refresh 的 await 链）；fake timers 下不能用 setTimeout */
const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
};

describe('cron store', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers();
    _resetCronEventWiring();
    useCronStore.setState({
      jobs: [],
      loading: false,
      error: null,
      loaded: false,
      profileFilter: 'all',
      busyJobIds: {},
      triggeringJobId: null,
    });
    useConnectionStore.setState({httpUrl: 'http://test', token: 'tok'});
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('refresh 成功：落 jobs、loaded=true、loading 复位', async () => {
    list.mockResolvedValue([job('a'), job('b')]);
    await useCronStore.getState().refresh();
    const s = useCronStore.getState();
    expect(s.jobs.map(j => j.id)).toEqual(['a', 'b']);
    expect(s.loaded).toBe(true);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it('refresh 失败（非 silent）：落 error', async () => {
    list.mockRejectedValue(new Error('网络挂了'));
    await useCronStore.getState().refresh();
    expect(useCronStore.getState().error).toBe('网络挂了');
    expect(useCronStore.getState().loading).toBe(false);
  });

  it('cron.changed：防抖 1s 后静默刷新；未加载过不刷；同一 RPC 只接线一次', async () => {
    list.mockResolvedValue([]);
    await useCronStore.getState().refresh();
    // 接线一次；loaded=true 前提下事件触发静默刷新
    expect(runtime.__mockOn).toHaveBeenCalledTimes(1);
    expect(runtime.__mockOn.mock.calls[0][0]).toBe('cron.changed');
    const handler = runtime.__mockOn.mock.calls[0][1] as () => void;
    const callsAfterLoad = list.mock.calls.length;

    handler();
    // 防抖窗口内不立即刷
    await jest.advanceTimersByTimeAsync(500);
    expect(list.mock.calls.length).toBe(callsAfterLoad);
    await jest.advanceTimersByTimeAsync(600);
    await flush();
    expect(list.mock.calls.length).toBe(callsAfterLoad + 1);

    // 未加载过的新会话（loaded=false）：事件不触发请求
    useCronStore.setState({loaded: false});
    handler();
    await jest.advanceTimersByTimeAsync(1200);
    await flush();
    expect(list.mock.calls.length).toBe(callsAfterLoad + 1);
  });

  it('pause：带 profile 调 REST、busy 清理、动作后静默刷新', async () => {
    list.mockResolvedValue([job('a')]);
    await useCronStore.getState().refresh();
    const base = list.mock.calls.length;
    pause.mockResolvedValue(job('a', {state: 'paused'}));
    await useCronStore.getState().pause(job('a'));
    expect(pause).toHaveBeenCalledWith(
      'http://test',
      'tok',
      'a',
      'default',
    );
    expect(useCronStore.getState().busyJobIds).toEqual({});
    expect(list.mock.calls.length).toBe(base + 1);
  });

  it('trigger：进行中置 triggeringJobId，结束清理；错误向上抛', async () => {
    list.mockResolvedValue([]);
    await useCronStore.getState().refresh();
    run.mockRejectedValue(new Error('任务正在运行'));
    await expect(useCronStore.getState().trigger(job('a'))).rejects.toThrow(
      '任务正在运行',
    );
    expect(useCronStore.getState().triggeringJobId).toBeNull();
  });

  it('remove：REST 参数与 busy 清理', async () => {
    list.mockResolvedValue([]);
    del.mockResolvedValue({ok: true});
    await useCronStore.getState().remove(job('x'));
    expect(del).toHaveBeenCalledWith('http://test', 'tok', 'x', 'default');
    expect(useCronStore.getState().busyJobIds).toEqual({});
  });

  it('isCronConflict：仅 409 判真', () => {
    const {CronHttpError} = jest.requireActual<typeof import('../src/rpc/cron')>(
      '../src/rpc/cron',
    );
    expect(isCronConflict(new CronHttpError(409, 'running'))).toBe(true);
    expect(isCronConflict(new CronHttpError(404, 'nope'))).toBe(false);
    expect(isCronConflict(new Error('x'))).toBe(false);
  });
});
