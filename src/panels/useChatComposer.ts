/**
 * useChatComposer — 聊天输入组合逻辑（输入框状态 + 斜杠补全 + 发送分流）。
 * 手机 ChatScreen 与桌面 ChatPane 共用；/model 特判与补全键盘导航也在这里。
 * 输入文本存 drafts store（按「会话跨重启身份」存、AsyncStorage 持久化）：
 * 重连换 live sid（navigation.replace 重建页面）、返回重进、进程被杀重启均不丢。
 * AI 输出中（busy）时发送动作改为「排队」（queuedPrompts store），等当前
 * 流程结束或用户点中断后由排水引擎逐条送出。
 */

import {useCallback} from 'react';

import {t} from '../i18n';
import {useChatStore} from '../store/chat';
import {useConnectionStore} from '../store/connection';
import {useDraftStore} from '../store/drafts';
import {useQueuedPromptsStore} from '../store/queuedPrompts';
import {sessionIdentityFor} from '../store/sessionIdentity';
import {alertError} from '../utils/alert';
import {useSlashCompletion} from '../utils/useSlashCompletion';

export function useChatComposer(
  sessionId: string,
  onOpenModelPicker: () => void,
  /** 消息真正发出/入队后的回调（裸 /model 早退不触发）：发送即回底恢复跟随 */
  onAfterSend?: () => void,
) {
  const connState = useConnectionStore(s => s.state);
  const sendPrompt = useChatStore(s => s.sendPrompt);
  /** AI 输出中（boolean 原始类型选择器，引用稳定） */
  const busy = useChatStore(s => s.bySession[sessionId]?.busy ?? false);
  // 草稿与排队统一按「会话跨重启身份」存（sessionIdentityFor：profile +
  // 持久化会话 id）。两个 string 选择器都是原始类型、引用稳定。
  // ——live sid 会在断线回收后换，拿它当 key 时 App 退出重进就读不到旧数据
  const profile = useChatStore(s => s.bySession[sessionId]?.profile ?? '');
  const storedId = useChatStore(
    s => s.bySession[sessionId]?.storedSessionId ?? '',
  );
  const enqueue = useQueuedPromptsStore(s => s.enqueue);

  const identity = sessionIdentityFor(profile, sessionId, storedId);
  const input = useDraftStore(s => s.drafts[identity] ?? '');
  const setInput = useCallback(
    (text: string) => useDraftStore.getState().setDraft(identity, text),
    [identity],
  );
  // 行首斜杠命令补全（数据全部来自服务端 complete.slash；/model 不进补全，
  // 提交时直接开 App 内模型面板——TUI 对 /model 的两步选择器同款特判）
  const slash = useSlashCompletion(input, connState === 'ready');

  /** 输入框键盘导航（硬件键盘/web 调试；移动端主要靠点选）。
   *  与 web dashboard SlashPopover 同款：↑↓ 循环选中、Tab 应用、Esc 关闭；
   *  Enter 不拦（保持多行输入换行语义，发送靠按钮）。 */
  const onInputKeyPress = useCallback(
    (e: {nativeEvent: {key: string}}) => {
      if (!slash.open) {
        return;
      }
      switch (e.nativeEvent.key) {
        case 'ArrowDown':
          slash.move(1);
          break;
        case 'ArrowUp':
          slash.move(-1);
          break;
        case 'Tab': {
          const next = slash.applySelected();
          if (next !== null) {
            setInput(next);
          }
          break;
        }
        case 'Escape':
          slash.close();
          break;
        default:
          break;
      }
    },
    [slash, setInput],
  );

  const onSend = useCallback(() => {
    // 裸 /model 是交互式选择而非文本参数：直接开 App 内模型面板；
    // 带参数的 /model xxx 及其它命令由 store 分流到执行流水线。
    if (input.trim() === '/model') {
      setInput('');
      onOpenModelPicker();
      return;
    }
    // AI 还在输出：默认发送动作改成「排队」——不打断当前 turn，等流程结束
    // （或用户点中断）由排水引擎带 queued 语义逐条送出
    if (busy) {
      if (!input.trim()) {
        // busy 且没有文本：什么都不发（待发图片仍留在服务端队列里，随下一次
        // 真实提交进上下文）——避免空文本 prompt 去打断/改写当前轮
        return;
      }
      if (!enqueue(sessionIdentityFor(profile, sessionId, storedId), input)) {
        // 单会话排队上限：提示且**保留输入**，不丢用户敲的内容
        alertError(t('input.queueFull'), '');
        return;
      }
      setInput('');
      onAfterSend?.();
      return;
    }
    sendPrompt(sessionId, input);
    setInput('');
    onAfterSend?.();
  }, [
    busy,
    enqueue,
    input,
    setInput,
    sendPrompt,
    sessionId,
    profile,
    storedId,
    onOpenModelPicker,
    onAfterSend,
  ]);

  return {
    input,
    setInput,
    slash,
    onInputKeyPress,
    onSend,
    ready: connState === 'ready',
  };
}
