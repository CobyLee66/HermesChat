/**
 * alert — 跨平台确认框/错误提示统一入口。
 *
 * RN 的 Alert.alert 在 react-native-web 下是无 UI 的 no-op（web 预览里
 * 删除会话等确认框点了没反应的根因）。桌面桥存在时走自绘弹层（ConfirmDialogHost），
 * 普通浏览器用 window.confirm/alert 兜底，原生侧保持系统 Alert。
 */

import {Alert, Platform} from 'react-native';

import {t} from '../i18n';
import {hasDesktopBridge} from '../ssh/desktopHermesSsh';
import {enqueueAlert, enqueueConfirm} from '../ui/dialogStore';

function routeToInAppDialogs(): boolean {
  return Platform.OS === 'web' && hasDesktopBridge();
}

/** 错误提示（无确认语义）。 */
export function alertError(title: string, message: string): void {
  if (routeToInAppDialogs()) {
    void enqueueAlert(title, message);
    return;
  }
  if (Platform.OS === 'web') {
    const g = globalThis as {alert?: (msg: string) => void};
    g.alert?.(`${title}\n${message}`);
    return;
  }
  Alert.alert(title, message);
}

/** 信息提示（成功/中性通知，无确认语义）。 */
export function alertInfo(title: string, message: string): void {
  alertError(title, message);
}

/** 确认框：resolve true = 确认。 */
export function confirmDialog(title: string, message: string): Promise<boolean> {
  if (routeToInAppDialogs()) {
    return enqueueConfirm(title, message);
  }
  if (Platform.OS === 'web') {
    const g = globalThis as {confirm?: (msg: string) => boolean};
    return Promise.resolve(g.confirm?.(`${title}\n${message}`) ?? false);
  }
  return new Promise(resolve => {
    Alert.alert(title, message, [
      {
        text: t('common.cancel'),
        style: 'cancel',
        onPress: () => resolve(false),
      },
      {
        text: t('common.ok'),
        style: 'destructive',
        onPress: () => resolve(true),
      },
    ]);
  });
}
