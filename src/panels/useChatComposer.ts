/**
 * useChatComposer — 聊天输入组合逻辑（输入框状态 + 斜杠补全 + 发送分流）。
 * 手机 ChatScreen 与桌面 ChatPane 共用；/model 特判与补全键盘导航也在这里。
 */

import {useCallback, useState} from 'react';

import {useChatStore} from '../store/chat';
import {useConnectionStore} from '../store/connection';
import {useSlashCompletion} from '../utils/useSlashCompletion';

export function useChatComposer(
  sessionId: string,
  onOpenModelPicker: () => void,
) {
  const connState = useConnectionStore(s => s.state);
  const sendPrompt = useChatStore(s => s.sendPrompt);

  const [input, setInput] = useState('');
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
    [slash],
  );

  const onSend = useCallback(() => {
    // 裸 /model 是交互式选择而非文本参数：直接开 App 内模型面板；
    // 带参数的 /model xxx 及其它命令由 store 分流到执行流水线。
    if (input.trim() === '/model') {
      setInput('');
      onOpenModelPicker();
      return;
    }
    sendPrompt(sessionId, input);
    setInput('');
  }, [input, sendPrompt, sessionId, onOpenModelPicker]);

  return {
    input,
    setInput,
    slash,
    onInputKeyPress,
    onSend,
    ready: connState === 'ready',
  };
}
