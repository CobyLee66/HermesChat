import {t} from '../i18n';
import type {ConnectionProfile} from '../store/connection';

export type ProfileForm = Omit<ConnectionProfile, 'id'>;

/** 字段级校验错误（key 与表单字段对应，auth 覆盖密码/私钥两项）。 */
export interface ProfileFormErrors {
  host?: string;
  port?: string;
  username?: string;
  auth?: string;
}

/**
 * 连接配置表单校验（保存前调用）。
 * 规则：主机/端口必填；SSH 类型下用户名必填、密码与私钥至少一项；
 * 直连类型不校验用户名与凭据（token 选填，留空自动提取）。
 */
export function validateProfileForm(form: ProfileForm): ProfileFormErrors {
  const errors: ProfileFormErrors = {};
  if (!form.host.trim()) {
    errors.host =
      form.type === 'direct'
        ? t('validation.gatewayHostRequired')
        : t('validation.sshHostRequired');
  }
  const port = form.port.trim();
  if (!port) {
    errors.port = t('validation.portRequired');
  } else {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      errors.port = t('validation.portInvalid');
    }
  }
  if (form.type === 'ssh') {
    if (!form.username.trim()) {
      errors.username = t('validation.usernameRequired');
    }
    if (!form.password && !form.privateKey.trim()) {
      errors.auth = t('validation.authRequired');
    }
  }
  return errors;
}

/** 把错误字典合并成弹窗正文（每条一行，保持字段顺序）。 */
export function formatProfileErrors(errors: ProfileFormErrors): string {
  return (Object.values(errors).filter(Boolean) as string[]).join('\n');
}
