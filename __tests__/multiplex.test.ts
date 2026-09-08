/**
 * multiplex 会话归属分组测试：
 * - namespace 解析 / 扫描命令与输出解析 / 分组过滤 / 会话列表 refresh 合并
 * - foreign 历史投影（hex 传输 + JSON parts 拍平）与 fork 种子
 * - forkMap 存取、fork-on-send 流程（rpc 全部 mock，不打真实服务）
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type {ProfileInfo, SessionListRow} from '../src/rpc/types';
import {
  buildScanCommand,
  collectDbPaths,
  EMPTY_NAMESPACE_MAP,
  fetchNamespaceMap,
  foreignHostsOf,
  parseNamespace,
  parseScanOutput,
  projectProfileSessions,
  type NamespaceMap,
} from '../src/ssh/namespaceMap';
import {
  buildHistoryCommand,
  coerceContentText,
  hexToUtf8,
  parseHistoryOutput,
  toSeedMessages,
} from '../src/ssh/remoteHistory';
import {setExecRemote} from '../src/ssh/execRemote';
import {getFork, setFork} from '../src/store/forkMap';
import {_resetChatAggregators, useChatStore} from '../src/store/chat';
import {useProfilesStore} from '../src/store/profiles';
import {useSessionsStore} from '../src/store/sessions';

const mockCall = jest.fn<Promise<unknown>, [string, Record<string, unknown>?]>();

jest.mock('../src/rpc/runtime', () => ({
  getRpc: () => ({call: mockCall}),
  setRpc: jest.fn(),
  hasRpc: () => true,
}));

function makeProfile(name: string, extra?: Partial<ProfileInfo>): ProfileInfo {
  return {
    name,
    path: `/h/.hermes/profiles/${name}`,
    is_default: false,
    model: 'm',
    provider: 'p',
    description: name,
    skill_count: 0,
    last_session: null,
    ...extra,
  };
}

/** 测试环境默认 profile 集合：default(根库, is_default) + main(大库) + finance + work */
function seedProfiles() {
  useProfilesStore.setState({
    list: [
      makeProfile('default', {path: '/h/.hermes', is_default: true}),
      makeProfile('main'),
      makeProfile('finance'),
      makeProfile('work'),
    ],
    avatars: {},
    loading: false,
    error: null,
  });
}

function row(id: string, startedAt: number, extra?: Partial<SessionListRow>): SessionListRow {
  return {
    id,
    title: `t-${id}`,
    preview: '',
    started_at: startedAt,
    message_count: 1,
    source: 'qqbot',
    ...extra,
  };
}

/** 测试内 UTF-8 → hex（不依赖 Buffer/node types，利用 encodeURIComponent 的 %XX 字节序列）。 */
function hex(s: string): string {
  const uri = encodeURIComponent(s);
  let out = '';
  for (let i = 0; i < uri.length; i++) {
    if (uri[i] === '%') {
      out += uri.slice(i + 1, i + 3).toLowerCase();
      i += 2;
    } else {
      out += uri.charCodeAt(i).toString(16).padStart(2, '0');
    }
  }
  return out;
}

function resetAll() {
  mockCall.mockReset();
  setExecRemote(null);
  _resetChatAggregators();
  useChatStore.setState({bySession: {}});
  useSessionsStore.setState({
    byProfile: {},
    loading: false,
    error: null,
    stale: false,
    nsMap: null,
  });
  useProfilesStore.setState({list: [], avatars: {}, loading: false, error: null});
}

// ─── namespace 解析 ────────────────────────────────────────────────

describe('parseNamespace', () => {
  it('agent:<ns>:... → ns；形状不符 → null', () => {
    expect(parseNamespace('agent:main:qqbot:dm:HASH')).toBe('main');
    expect(parseNamespace('agent:mental-health:qqbot:dm:X')).toBe('mental-health');
    expect(parseNamespace('agent:finance:qqbot:group:Y')).toBe('finance');
    expect(parseNamespace('')).toBeNull();
    expect(parseNamespace(null)).toBeNull();
    expect(parseNamespace(undefined)).toBeNull();
    expect(parseNamespace('qqbot:dm:x')).toBeNull();
    expect(parseNamespace('agent:')).toBeNull();
    expect(parseNamespace('agent:main')).toBeNull();
    expect(parseNamespace('agent::x')).toBeNull();
  });
});

// ─── 库路径收集 + 扫描命令 ────────────────────────────────────

describe('collectDbPaths / buildScanCommand', () => {
  it('profile 库 + hermes 根兜底（去重），dbToProfile 归属正确', () => {
    const profiles = [
      makeProfile('default', {path: '/h/.hermes', is_default: true}),
      makeProfile('main'),
      makeProfile('finance'),
    ];
    const {dbPaths, dbToProfile} = collectDbPaths(profiles);
    expect(dbPaths).toEqual([
      '/h/.hermes/state.db',
      '/h/.hermes/profiles/main/state.db',
      '/h/.hermes/profiles/finance/state.db',
    ]);
    // 根库 = default 的 path（去重后仍归 default）
    expect(dbToProfile['/h/.hermes/state.db']).toBe('default');
    expect(dbToProfile['/h/.hermes/profiles/main/state.db']).toBe('main');
    expect(dbToProfile['/h/.hermes/profiles/finance/state.db']).toBe('finance');
  });

  it('无 is_default 时根库兜底归 default 名；无 profiles/ 结构时不加根库', () => {
    const {dbPaths, dbToProfile} = collectDbPaths([
      makeProfile('main'),
      makeProfile('solo', {path: '/data/hermes-home'}),
    ]);
    expect(dbPaths).toContain('/h/.hermes/state.db');
    expect(dbToProfile['/h/.hermes/state.db']).toBe('default');
    // /data/hermes-home 不匹配 profiles/<name> 结构 → 不派生根库
    expect(dbPaths).not.toContain('/data/state.db');
  });

  it('扫描命令：只读 mode=ro、#DB 标记、全表带活跃时间、路径加引号', () => {
    const cmd = buildScanCommand(['/h/.hermes/state.db', "/h/o'b/state.db"]);
    expect(cmd).toContain('mode=ro');
    expect(cmd).toContain('#DB $db');
    // 活跃时间 = MAX(last_activity_at 心跳, 最新消息时间)，兜底 started_at
    expect(cmd).toContain('last_activity_at');
    expect(cmd).toContain('MAX(m.timestamp)');
    expect(cmd).toContain('s.started_at, 0');
    // 全表扫描（归属映射在解析侧过滤 agent: 前缀），不再 LIKE 过滤
    expect(cmd).not.toContain(`session_key LIKE 'agent:%'`);
    expect(cmd).toContain(`'/h/.hermes/state.db'`);
    // 单引号转义
    expect(cmd).toContain(`'/h/o'\\''b/state.db'`);
  });
});

// ─── 扫描输出解析 ────────────────────────────────────────────────

describe('parseScanOutput', () => {
  it('按 #DB 标记归属宿主，垃圾行/未知宿主跳过；活跃时间全行收集', () => {
    const stdout = [
      '#DB /h/.hermes/profiles/main/state.db',
      'rowA\tagent:finance:qqbot:dm:HASH1\t1000.5',
      'rowB\tagent:main:qqbot:dm:HASH2\t2000',
      'appRow\t\t2500.75', // App 创建（无 agent: 前缀）：只进活跃表
      'garbage line without tab',
      '\t',
      'noTabLine',
      '#DB /h/.hermes/profiles/finance/state.db',
      'rowC\tagent:work:qqbot:dm:HASH3\tnot-a-number', // 非数字活跃时间：仅归属
      '#DB /h/unknown/state.db',
      'rowD\tagent:finance:qqbot:dm:HASH4\t3000', // 宿主未知：不进归属表、进活跃表
    ].join('\n');
    const map = parseScanOutput(stdout, {
      '/h/.hermes/profiles/main/state.db': 'main',
      '/h/.hermes/profiles/finance/state.db': 'finance',
    });
    expect(map.byId).toEqual({
      rowA: {namespace: 'finance', host: 'main'},
      rowB: {namespace: 'main', host: 'main'},
      rowC: {namespace: 'work', host: 'finance'},
      // rowD：宿主不在已知 profile 表 → 丢弃
    });
    expect(map.lastActiveById).toEqual({
      rowA: 1000.5,
      rowB: 2000,
      appRow: 2500.75,
      rowD: 3000,
    });
  });
});

// ─── fetchNamespaceMap 集成（exec mock） ──────────────────────────

describe('fetchNamespaceMap / foreignHostsOf', () => {
  it('exec → 命令含全部库路径 → 解析出映射；foreignHostsOf 排除自身', async () => {
    let seenCmd = '';
    const map = await fetchNamespaceMap(async cmd => {
      seenCmd = cmd;
      return {
        stdout: [
          '#DB /h/.hermes/state.db',
          '#DB /h/.hermes/profiles/main/state.db',
          'rowA\tagent:finance:qqbot:dm:H1\t111',
          'rowB\tagent:main:qqbot:dm:H2\t222',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }, [
      makeProfile('default', {path: '/h/.hermes', is_default: true}),
      makeProfile('main'),
      makeProfile('finance'),
    ]);
    expect(seenCmd).toContain('/h/.hermes/profiles/main/state.db');
    expect(seenCmd).toContain('/h/.hermes/state.db');
    expect(map.byId.rowA).toEqual({namespace: 'finance', host: 'main'});
    expect(map.byId.rowB).toEqual({namespace: 'main', host: 'main'});
    expect(map.lastActiveById).toEqual({rowA: 111, rowB: 222});
    // finance 的 foreign 宿主 = main；main 自身不是自己的 foreign 宿主
    expect(foreignHostsOf(map, 'finance', 'finance')).toEqual(['main']);
    expect(foreignHostsOf(map, 'main', 'main')).toEqual([]);
  });

  it('exec 抛错 → 空映射（静默降级）', async () => {
    const map = await fetchNamespaceMap(
      async () => {
        throw new Error('ssh dropped');
      },
      [makeProfile('main')],
    );
    expect(map).toEqual(EMPTY_NAMESPACE_MAP);
  });
});

// ─── 分组投影 ────────────────────────────────────────────────

describe('projectProfileSessions 分组过滤', () => {
  const MAP: NamespaceMap = {
    byId: {
      qqFin: {namespace: 'finance', host: 'main'},
      qqMain: {namespace: 'main', host: 'main'},
      qqGhost: {namespace: 'ghost', host: 'main'}, // ghost 不在现存 profile 里
    },
    lastActiveById: {},
  };
  const known = new Set(['default', 'main', 'finance', 'work']);

  it('宿主（main）视角：排除其他现存 profile 的命名空间，单库行保持服务端返回序', () => {
    const own = [
      row('app1', 300), // App 创建（无映射）
      row('qqFin', 200),
      row('qqMain', 100),
      row('qqGhost', 50),
    ];
    const out = projectProfileSessions({
      own,
      foreign: [],
      map: MAP,
      profile: 'main',
      knownProfiles: known,
    });
    expect(out.map(r => r.id)).toEqual(['app1', 'qqMain', 'qqGhost']);
  });

  it('无 foreign：不按 started_at 重排（服务端 last_active 序是唯一权威）', () => {
    const own = [row('oldButActive', 100), row('newIdle', 900)];
    const out = projectProfileSessions({
      own,
      foreign: [],
      map: MAP,
      profile: 'main',
      knownProfiles: known,
    });
    // started_at 降序会得到 [newIdle, oldButActive]，必须保持原序
    expect(out.map(r => r.id)).toEqual(['oldButActive', 'newIdle']);
  });

  it('foreign 视角（finance）：合并去重；无活跃数据时回退 started_at 降序', () => {
    const own = [row('ownF', 400)];
    const foreign = [
      row('qqFin', 200, {namespaced: true, hostProfile: 'main'}),
      // 重复 id（极端：同时出现在 own 库与大库）→ 去重，own 优先
      row('ownF', 400, {namespaced: true, hostProfile: 'main'}),
    ];
    const out = projectProfileSessions({
      own,
      foreign,
      map: MAP,
      profile: 'finance',
      knownProfiles: known,
    });
    expect(out.map(r => r.id)).toEqual(['ownF', 'qqFin']);
    expect(out[1].namespaced).toBe(true);
    expect(out[1].hostProfile).toBe('main');
  });

  it('有 foreign：按扫描活跃时间跨库交错（活跃时间 ≠ started_at）', () => {
    const map: NamespaceMap = {
      byId: {qqFin: {namespace: 'finance', host: 'main'}},
      lastActiveById: {ownOld: 100, qqNew: 500, ownMid: 300},
    };
    const own = [
      row('ownOld', 100, {last_active: 100}),
      row('ownMid', 300, {last_active: 300}),
    ];
    const foreign = [row('qqNew', 200, {namespaced: true, hostProfile: 'main'})];
    const out = projectProfileSessions({
      own,
      foreign,
      map,
      profile: 'finance',
      knownProfiles: known,
    });
    // started_at 序是 [ownMid(300), qqNew(200), ownOld(100)]；
    // 活跃序应为 qqNew(500) > ownMid(300) > ownOld(100)
    expect(out.map(r => r.id)).toEqual(['qqNew', 'ownMid', 'ownOld']);
  });

  it('扫描活跃时间挂到行（last_active）；与 started_at 相同/缺失时不改行', () => {
    const map: NamespaceMap = {
      byId: {},
      lastActiveById: {a: 111, b: 222},
    };
    const own = [row('a', 111), row('b', 999), row('c', 50)];
    const out = projectProfileSessions({
      own,
      foreign: [],
      map,
      profile: 'finance',
      knownProfiles: known,
    });
    expect(out.find(r => r.id === 'a')?.last_active).toBeUndefined(); // 与 started_at 相同 → 不复制行
    expect(out.find(r => r.id === 'b')?.last_active).toBe(222);
    expect(out.find(r => r.id === 'c')?.last_active).toBeUndefined(); // 扫描缺失
    expect(out.map(r => r.id)).toEqual(['a', 'b', 'c']); // 服务端原序
  });
});

// ─── sessions store refresh 分组 ──────────────────────────────

describe('sessions store refresh 分组', () => {
  beforeEach(async () => {
    resetAll();
    await AsyncStorage.clear();
    seedProfiles();
  });

  it('finance 视角：own 为空 + 大库 foreign 行（namespaced 标记）合并', async () => {
    setExecRemote(async () => ({
      stdout: [
        '#DB /h/.hermes/state.db',
        '#DB /h/.hermes/profiles/main/state.db',
        'rowA\tagent:finance:qqbot:dm:H1\t1700',
        'rowB\tagent:main:qqbot:dm:H2\t1600',
        '#DB /h/.hermes/profiles/finance/state.db',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    }));
    mockCall.mockImplementation(async (method: string, params) => {
      if (method === 'session.list') {
        const p = (params as {profile: string}).profile;
        if (p === 'main') {
          return {sessions: [row('rowA', 200), row('rowB', 100), row('cron1', 300)]};
        }
        if (p === 'finance') {
          return {sessions: []};
        }
        return {sessions: []};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });

    await useSessionsStore.getState().refresh('finance', true);
    const list = useSessionsStore.getState().byProfile.finance;
    expect(list.map(r => r.id)).toEqual(['rowA']);
    expect(list[0].namespaced).toBe(true);
    expect(list[0].hostProfile).toBe('main');
    // 拉了自己 + 宿主两个列表
    const listCalls = mockCall.mock.calls.filter(c => c[0] === 'session.list');
    expect(listCalls.map(c => (c[1] as {profile: string}).profile).sort()).toEqual(
      ['finance', 'main'],
    );
  });

  it('main（大库宿主）视角：排除 finance 命名空间，保留自身与无映射行', async () => {
    setExecRemote(async () => ({
      stdout: [
        '#DB /h/.hermes/profiles/main/state.db',
        'rowA\tagent:finance:qqbot:dm:H1\t1700',
        'rowB\tagent:main:qqbot:dm:H2\t1600',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    }));
    mockCall.mockImplementation(async (method: string, params) => {
      if (method === 'session.list') {
        const p = (params as {profile: string}).profile;
        if (p === 'main') {
          return {
            sessions: [row('rowA', 200), row('rowB', 100), row('cron1', 300)],
          };
        }
        return {sessions: []};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });

    await useSessionsStore.getState().refresh('main', true);
    const list = useSessionsStore.getState().byProfile.main;
    // rowA（finance 命名空间）被排除；无 foreign → 保持服务端返回序
    expect(list.map(r => r.id)).toEqual(['rowB', 'cron1']);
    expect(list.every(r => !r.namespaced)).toBe(true);
  });

  it('finance：跨库行按扫描活跃时间交错（最近消息档口径）', async () => {
    setExecRemote(async () => ({
      stdout: [
        '#DB /h/.hermes/profiles/main/state.db',
        'qqA\tagent:finance:qqbot:dm:H1\t5000', // QQ 会话刚活跃
        '#DB /h/.hermes/profiles/finance/state.db',
        'ownOld\t\t1000', // App 创建的老会话（创建时间晚于 qqA 但久未活跃）
        'ownNew\t\t900',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    }));
    mockCall.mockImplementation(async (method: string, params) => {
      if (method === 'session.list') {
        const p = (params as {profile: string}).profile;
        if (p === 'main') {
          return {sessions: [row('qqA', 200, {source: 'qqbot'})]};
        }
        if (p === 'finance') {
          // own 库按服务端 last_active 序返回
          return {sessions: [row('ownOld', 3000), row('ownNew', 800)]};
        }
        return {sessions: []};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });

    await useSessionsStore.getState().refresh('finance', true);
    const list = useSessionsStore.getState().byProfile.finance;
    // 活跃序 qqA(5000) > ownOld(1000) > ownNew(900)；started_at 序会错置 ownOld 第一
    expect(list.map(r => r.id)).toEqual(['qqA', 'ownOld', 'ownNew']);
    expect(list.map(r => r.last_active)).toEqual([5000, 1000, 900]);
  });

  it('exec 不可用（web）：映射为空，行为 = 现状（只拉自己）', async () => {
    mockCall.mockImplementation(async (method: string, params) => {
      if (method === 'session.list') {
        const p = (params as {profile: string}).profile;
        if (p === 'finance') {
          return {sessions: [row('ownF', 100)]};
        }
        return {sessions: [row('x', 1)]};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });

    await useSessionsStore.getState().refresh('finance', true);
    const list = useSessionsStore.getState().byProfile.finance;
    expect(list.map(r => r.id)).toEqual(['ownF']);
    // 只拉了自己的列表（无宿主拉取）
    const listCalls = mockCall.mock.calls.filter(c => c[0] === 'session.list');
    expect(listCalls).toHaveLength(1);
    expect(useSessionsStore.getState().nsMap).toEqual(EMPTY_NAMESPACE_MAP);
  });

  it('markStale 使映射失效：下次 refresh 重建（exec 再跑一次）', async () => {
    let execCount = 0;
    setExecRemote(async () => {
      execCount += 1;
      return {stdout: '', stderr: '', exitCode: 0};
    });
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'session.list') {
        return {sessions: []};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });

    await useSessionsStore.getState().refresh('finance', true);
    expect(execCount).toBe(1);
    useSessionsStore.getState().markStale();
    expect(useSessionsStore.getState().nsMap).toBeNull();
    await useSessionsStore.getState().refresh('finance', true);
    expect(execCount).toBe(2);
  });
});

// ─── foreign 历史投影 ─────────────────────────────────────────

describe('remoteHistory 历史投影', () => {
  it('buildHistoryCommand：只读、按 session_id、限定 role、hex 传输', () => {
    const cmd = buildHistoryCommand('/h/.hermes/profiles/main/state.db', 'SES1');
    expect(cmd).toContain(`'file:/h/.hermes/profiles/main/state.db?mode=ro'`);
    expect(cmd).toContain(`session_id='SES1'`);
    expect(cmd).toContain(`role IN ('user','assistant','system')`);
    expect(cmd).toContain('hex(COALESCE(content');
  });

  it('parseHistoryOutput：hex 还原中文、跳过 tool/session_meta/空行，时间戳与 display_kind 保留', () => {
    const stdout = [
      `user\t${hex('你好，在吗？')}\t1787538000\t`,
      `session_meta\t\t1787538001\t`,
      `assistant\t${hex('在的，有什么可以帮你？')}\t1787538002\t`,
      `tool\t${hex('big tool result')}\t1787538003\t`,
      `user\t\t1787538004\t`,
    ].join('\n');
    const out = parseHistoryOutput(stdout);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({role: 'user', text: '你好，在吗？', timestamp: 1787538000});
    expect(out[1]).toMatchObject({role: 'assistant', text: '在的，有什么可以帮你？'});
  });

  it('coerceContentText：JSON parts 拍平（text + image_url 行）', () => {
    const parts = JSON.stringify([
      {type: 'text', text: '看这张图'},
      {type: 'image_url', image_url: {url: 'data:image/png;base64,AAA'}},
    ]);
    expect(coerceContentText(parts)).toBe('看这张图\ndata:image/png;base64,AAA');
    expect(coerceContentText('纯文本保持原文')).toBe('纯文本保持原文');
  });

  it('toSeedMessages：只留 user/assistant/system 且无 display_kind 的行，形状 {role,text}', () => {
    const seed = toSeedMessages([
      {role: 'user', text: '问题'},
      {role: 'assistant', text: '回答'},
      {role: 'assistant', text: ' ', display_kind: undefined},
      {role: 'user', text: 'skill 调用', display_kind: 'skill_invocation'},
      {role: 'system', text: '系统提示'},
    ]);
    expect(seed).toEqual([
      {role: 'user', text: '问题'},
      {role: 'assistant', text: '回答'},
      {role: 'system', text: '系统提示'},
    ]);
  });

  it('hexToUtf8 与 hex() 互逆（中文/emoji）', () => {
    expect(hexToUtf8(hex('中文 🎉 emoji'))).toBe('中文 🎉 emoji');
    expect(hexToUtf8('')).toBe('');
  });
});

// ─── forkMap 存取 ─────────────────────────────────────────────

describe('forkMap 存取', () => {
  beforeEach(async () => {
    resetAll();
    await AsyncStorage.clear();
  });

  it('set/get 往返；profile 不匹配 → null', async () => {
    await setFork('ORIG', 'finance', 'FORK1');
    expect(await getFork('ORIG', 'finance')).toEqual({
      forkId: 'FORK1',
      profile: 'finance',
    });
    expect(await getFork('ORIG', 'work')).toBeNull();
    expect(await getFork('NOPE', 'finance')).toBeNull();
  });

  it('覆盖写生效；损坏数据视为空', async () => {
    await setFork('ORIG', 'finance', 'F1');
    await setFork('ORIG', 'finance', 'F2');
    expect((await getFork('ORIG', 'finance'))?.forkId).toBe('F2');
    await AsyncStorage.setItem('hermes.forkMap.v1', '{broken json');
    expect(await getFork('ORIG', 'finance')).toBeNull();
  });
});

// ─── fork-on-send 派生流程 ────────────────────────────────────

describe('fork-on-send（foreign 会话首次发送派生）', () => {
  beforeEach(async () => {
    resetAll();
    await AsyncStorage.clear();
    seedProfiles();
  });

  function attachForeign(originId: string, profile = 'work') {
    useChatStore.getState().attach(originId, {
      messages: [{role: 'user', text: '早前消息'}],
      profile,
      storedSessionId: originId,
      foreign: {originId, hostProfile: 'main'},
    });
  }

  it('无 fork 记录：只读历史 → session.create(parent+seed) → submit 到新会话', async () => {
    setExecRemote(async () => ({
      stdout: [
        `user\t${hex('之前的问题')}\t1787538000\t`,
        `assistant\t${hex('之前的回答')}\t1787538001\t`,
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    }));
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'session.create') {
        return {
          session_id: 'LIVE1',
          stored_session_id: 'FORK1',
          message_count: 2,
          messages: [
            {role: 'user', text: '之前的问题'},
            {role: 'assistant', text: '之前的回答'},
          ],
          info: {profile_name: 'work'},
        };
      }
      if (method === 'prompt.submit') {
        return {status: 'streaming'};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });

    attachForeign('ORIG');
    await useChatStore.getState().sendPrompt('ORIG', '继续聊');

    // create 参数：profile 目标、parent_session_id = 原 id、种子消息形状 {role,text}
    expect(mockCall).toHaveBeenCalledWith('session.create', {
      profile: 'work',
      parent_session_id: 'ORIG',
      messages: [
        {role: 'user', text: '之前的问题'},
        {role: 'assistant', text: '之前的回答'},
      ],
      cols: 100,
      title: '',
    });
    // submit 发到派生会话的 live sid
    expect(mockCall).toHaveBeenCalledWith('prompt.submit', {
      session_id: 'LIVE1',
      text: '继续聊',
    });
    // create 在 submit 之前
    const order = mockCall.mock.calls.map(c => c[0]);
    expect(order.indexOf('session.create')).toBeLessThan(
      order.indexOf('prompt.submit'),
    );
    // forkMap 落盘 + 旧 key 标记迁移 + 新 key 挂正常状态
    expect(await getFork('ORIG', 'work')).toEqual({
      forkId: 'FORK1',
      profile: 'work',
    });
    const old = useChatStore.getState().bySession.ORIG;
    expect(old.migratedTo).toBe('LIVE1');
    expect(old.forking).toBe(false);
    const next = useChatStore.getState().bySession.LIVE1;
    expect(next.profile).toBe('work');
    expect(next.storedSessionId).toBe('FORK1');
    expect(next.foreign).toBeNull();
    const lastItem = next.items[next.items.length - 1];
    expect(lastItem).toMatchObject({kind: 'user', text: '继续聊'});
    // 会话列表标脏（下次进入刷新出 fork）
    expect(useSessionsStore.getState().stale).toBe(true);
  });

  it('forkMap 命中：直接 resume fork（无 session.create）', async () => {
    await setFork('ORIG2', 'work', 'FORK9');
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'session.resume') {
        return {
          session_id: 'LIVE9',
          stored_session_id: 'FORK9',
          resumed: 'FORK9',
          messages: [],
          info: {profile_name: 'work'},
        };
      }
      if (method === 'prompt.submit') {
        return {status: 'streaming'};
      }
      throw new Error(`unexpected rpc: ${method}`);
    });

    attachForeign('ORIG2');
    await useChatStore.getState().sendPrompt('ORIG2', '再聊一次');

    expect(mockCall).toHaveBeenCalledWith('session.resume', {
      session_id: 'FORK9',
      profile: 'work',
      cols: 100,
    });
    expect(
      mockCall.mock.calls.some(c => c[0] === 'session.create'),
    ).toBe(false);
    expect(mockCall).toHaveBeenCalledWith('prompt.submit', {
      session_id: 'LIVE9',
      text: '再聊一次',
    });
  });

  it('派生失败：错误条提示 + forking 复位 + 不迁移', async () => {
    setExecRemote(async () => ({
      stdout: `user\t${hex('问')}\t1787538000\t`,
      stderr: '',
      exitCode: 0,
    }));
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'session.create') {
        throw new Error('profile busy');
      }
      throw new Error(`unexpected rpc: ${method}`);
    });

    attachForeign('ORIG3');
    await useChatStore.getState().sendPrompt('ORIG3', '发不出去');

    const st = useChatStore.getState().bySession.ORIG3;
    expect(st.forking).toBe(false);
    expect(st.migratedTo).toBeUndefined();
    const errItem = st.items.find(
      it => it.kind === 'system' && it.eventKind === 'error',
    );
    expect(errItem).toBeDefined();
    expect(errItem && 'text' in errItem ? errItem.text : '').toContain(
      '派生到当前 profile 失败',
    );
    // 未写 forkMap
    expect(await getFork('ORIG3', 'work')).toBeNull();
  });

  it('无 SSH exec（web 直连）：派生报友好错误', async () => {
    mockCall.mockImplementation(async () => {
      throw new Error('should not be called');
    });
    attachForeign('ORIG4');
    await useChatStore.getState().sendPrompt('ORIG4', 'hello');
    const st = useChatStore.getState().bySession.ORIG4;
    const errItem = st.items.find(
      it => it.kind === 'system' && it.eventKind === 'error',
    );
    expect(errItem && 'text' in errItem ? errItem.text : '').toContain('需要 SSH 连接');
  });
});
