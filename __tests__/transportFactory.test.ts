/**
 * transportFactory 按配置类型分发（ssh / direct）+ SshManager execRemote 门控。
 * HermesSsh mock 成 isAvailable=true 以验证门控的 sshMode 分支；
 * RpcClient mock 掉 WS 连接（SshManager.connect 内部会 new RpcClient().connect）。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import {DirectTransport} from '../src/ssh/directTransport';
import {
  DesktopDirectTransport,
  DesktopSshTransport,
  desktopTransportFactory,
} from '../src/ssh/desktopBridge';
import {
  defaultTransportFactory,
  SshManager,
} from '../src/ssh/SshManager';
import type {ConnectionProfile} from '../src/store/connection';
import {EMPTY_PROFILE} from '../src/store/connection';
import {SshTunnelTransport, type Transport} from '../src/ssh/transport';
import {
  WebDirectTransport,
  webDirectTransportFactory,
} from '../src/ssh/webDirect';

jest.mock('../src/ssh/HermesSsh', () => ({
  isAvailable: true,
  DEFAULT_EXEC_TIMEOUT_MS: 20_000,
  exec: jest.fn().mockResolvedValue({stdout: '', stderr: '', exitCode: 0}),
  onDisconnect: jest.fn().mockReturnValue(() => {}),
  onStdout: jest.fn().mockReturnValue(() => {}),
  onExit: jest.fn().mockReturnValue(() => {}),
}));

jest.mock('../src/rpc/client', () => ({
  RpcClient: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    isOpen: true,
    onAny: jest.fn(),
  })),
}));

function makeProfile(patch: Partial<ConnectionProfile>): ConnectionProfile {
  return {
    ...EMPTY_PROFILE,
    id: 'p1',
    name: '测试',
    host: '10.0.0.2',
    port: '22',
    ...patch,
  };
}

describe('transportFactory 按类型分发', () => {
  it('原生默认工厂：direct → DirectTransport，ssh → SshTunnelTransport', () => {
    expect(
      defaultTransportFactory(makeProfile({type: 'direct', port: '9119'})),
    ).toBeInstanceOf(DirectTransport);
    expect(
      defaultTransportFactory(makeProfile({type: 'ssh', username: 'dev'})),
    ).toBeInstanceOf(SshTunnelTransport);
  });

  it('桌面工厂：direct → DesktopDirectTransport，ssh → DesktopSshTransport', () => {
    expect(
      desktopTransportFactory(makeProfile({type: 'direct', port: '9119'})),
    ).toBeInstanceOf(DesktopDirectTransport);
    expect(
      desktopTransportFactory(makeProfile({type: 'ssh', username: 'dev'})),
    ).toBeInstanceOf(DesktopSshTransport);
  });

  it('web 工厂：direct 与 web-direct 伪配置 → WebDirectTransport；真实 SSH 配置拒绝', () => {
    expect(
      webDirectTransportFactory(makeProfile({type: 'direct'})),
    ).toBeInstanceOf(WebDirectTransport);
    expect(
      webDirectTransportFactory(
        makeProfile({type: 'direct', host: 'web-direct'}),
      ),
    ).toBeInstanceOf(WebDirectTransport);
    expect(() =>
      webDirectTransportFactory(
        makeProfile({type: 'ssh', username: 'dev'}),
      ),
    ).toThrow('浏览器环境不支持');
  });
});

describe('SshManager execRemote 门控（直连无 SSH 会话）', () => {
  const fakeTransport: Transport = {
    connect: async () => ({
      wsUrl: 'ws://upstream/api/ws?token=t',
      httpUrl: 'http://upstream',
      token: 't',
    }),
    disconnect: async () => {},
  };

  afterEach(async () => {
    await AsyncStorage.clear();
  });

  it('连接 direct 配置 → execRemote undefined；改连 ssh → 恢复提供', async () => {
    const mgr = new SshManager({transportFactory: () => fakeTransport});
    await mgr.connect(makeProfile({type: 'direct', port: '9119'}));
    expect(mgr.execRemote).toBeUndefined();

    await mgr.connect(makeProfile({type: 'ssh', username: 'dev'}));
    expect(typeof mgr.execRemote).toBe('function');
    await mgr.disconnect();
  });
});
