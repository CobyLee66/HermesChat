/**
 * jest 全局 setup：把 i18n 生效语言固定为 zh-CN。
 *
 * 原因：jest 环境里原生 locale 检测（NativeModules.I18nManager）不存在，
 * 初始语言解析回退 en，导致断言中文文案的既有用例全部拿到英文译文。
 * 测试统一钉在 zh-CN，保持用例原文语义稳定；i18n 自身的语言矩阵行为
 * 由 __tests__/i18n.test.ts 显式切换 locale 覆盖。
 */
import {useLocaleStore} from '../src/i18n/localeStore';

beforeAll(() => {
  useLocaleStore.setState({mode: 'zh-CN', locale: 'zh-CN'});
});
