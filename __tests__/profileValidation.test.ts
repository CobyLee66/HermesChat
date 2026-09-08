/**
 * 连接配置表单校验（保存前）：
 * - 主机/端口必填，端口须为 1–65535 整数；
 * - SSH 类型：用户名必填、密码与私钥至少一项；
 * - 直连类型：不校验用户名与凭据（token 选填）。
 */

import {
  formatProfileErrors,
  validateProfileForm,
} from '../src/utils/profileValidation';
import {EMPTY_PROFILE} from '../src/store/connection';
import type {ProfileForm} from '../src/utils/profileValidation';

function form(patch: Partial<ProfileForm>): ProfileForm {
  return {...EMPTY_PROFILE, ...patch};
}

describe('validateProfileForm', () => {
  test('合法 SSH 配置（密码认证）通过', () => {
    expect(
      validateProfileForm(
        form({
          type: 'ssh',
          host: '192.168.1.10',
          port: '22',
          username: 'root',
          password: 'secret',
        }),
      ),
    ).toEqual({});
  });

  test('合法直连配置（无用户名/凭据）通过', () => {
    expect(
      validateProfileForm(
        form({type: 'direct', host: '127.0.0.1', port: '9119'}),
      ),
    ).toEqual({});
  });

  test('主机为空或纯空白报错，SSH/直连文案不同', () => {
    expect(validateProfileForm(form({type: 'ssh'})).host).toBe(
      '请填写 SSH 主机地址',
    );
    expect(validateProfileForm(form({type: 'direct'})).host).toBe(
      '请填写 Gateway 主机地址',
    );
    expect(validateProfileForm(form({host: '   '})).host).toBeTruthy();
  });

  test('端口为空报错', () => {
    expect(validateProfileForm(form({host: 'h', port: ''})).port).toBe(
      '请填写端口',
    );
    expect(validateProfileForm(form({host: 'h', port: '  '})).port).toBe(
      '请填写端口',
    );
  });

  test('端口非整数或越界报错', () => {
    expect(validateProfileForm(form({host: 'h', port: 'abc'})).port).toBe(
      '端口需为 1–65535 的整数',
    );
    expect(validateProfileForm(form({host: 'h', port: '22.5'})).port).toBe(
      '端口需为 1–65535 的整数',
    );
    expect(validateProfileForm(form({host: 'h', port: '0'})).port).toBeTruthy();
    expect(
      validateProfileForm(form({host: 'h', port: '65536'})).port,
    ).toBeTruthy();
    expect(validateProfileForm(form({host: 'h', port: '65535'})).port).toBe(
      undefined,
    );
  });

  test('SSH 类型用户名为空报错', () => {
    expect(validateProfileForm(form({host: 'h', password: 'x'})).username).toBe(
      '请填写 SSH 用户名',
    );
    expect(
      validateProfileForm(
        form({type: 'direct', host: 'h'}),
      ).username,
    ).toBeUndefined();
  });

  test('SSH 类型密码与私钥全空报错，任一有值即通过', () => {
    expect(validateProfileForm(form({host: 'h', username: 'root'})).auth).toBe(
      '密码与私钥至少填写一项',
    );
    expect(
      validateProfileForm(form({host: 'h', username: 'root', privateKey: '  '}))
        .auth,
    ).toBe('密码与私钥至少填写一项');
    expect(
      validateProfileForm(form({host: 'h', username: 'root', password: 'x'}))
        .auth,
    ).toBeUndefined();
    expect(
      validateProfileForm(
        form({host: 'h', username: 'root', privateKey: '-----BEGIN'}),
      ).auth,
    ).toBeUndefined();
  });

  test('直连类型不校验凭据', () => {
    const errors = validateProfileForm(form({type: 'direct', host: 'h'}));
    expect(errors.auth).toBeUndefined();
    expect(errors.username).toBeUndefined();
  });

  test('多条错误按 host→port→username→auth 顺序合并', () => {
    expect(formatProfileErrors(validateProfileForm(form({port: ''})))).toBe(
      '请填写 SSH 主机地址\n请填写端口\n请填写 SSH 用户名\n密码与私钥至少填写一项',
    );
  });
});
