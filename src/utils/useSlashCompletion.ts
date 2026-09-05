import {useCallback, useEffect, useRef, useState} from 'react';

import {
  applyCompletion,
  isModelCommandInput,
  normalizeCompletionResponse,
  type SlashCompletionItem,
} from '../rpc/slash';
import {getRpc, hasRpc} from '../rpc/runtime';

/** 与 web dashboard SlashPopover 一致的补全请求防抖。 */
const DEBOUNCE_MS = 60;

/**
 * 行首斜杠命令补全（服务端 complete.slash 负责匹配/排序/参数阶段提示，
 * 前端不做过滤）。input 不以 / 开头时不出补全；/model 交由 App 内模型
 * 面板两步选择（TUI 同款特判），不进补全列表。
 */
export function useSlashCompletion(input: string, enabled: boolean) {
  const [items, setItems] = useState<SlashCompletionItem[]>([]);
  const [replaceFrom, setReplaceFrom] = useState(1);
  const [selected, setSelected] = useState(0);
  /** 仅用于丢弃迟到的响应：只有最后一次请求的 input 才允许落 state。 */
  const lastInputRef = useRef('');

  useEffect(() => {
    const trimmed = input ?? '';
    if (!enabled || !trimmed.startsWith('/') || isModelCommandInput(trimmed)) {
      if (!trimmed.startsWith('/')) {
        lastInputRef.current = '';
      }
      setItems([]);
      return;
    }
    lastInputRef.current = trimmed;

    const timer = setTimeout(() => {
      if (lastInputRef.current !== trimmed || !hasRpc()) {
        return;
      }
      getRpc()
        .call('complete.slash', {text: trimmed})
        .then(r => {
          if (lastInputRef.current !== trimmed) {
            return;
          }
          const normalized = normalizeCompletionResponse(r);
          setItems(normalized.items);
          setReplaceFrom(normalized.replaceFrom);
          setSelected(0);
        })
        .catch(() => {
          if (lastInputRef.current === trimmed) {
            setItems([]);
          }
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input, enabled]);

  const open = items.length > 0 && input.startsWith('/') && !isModelCommandInput(input);

  /** 键盘 ↑↓ 循环移动选中项。 */
  const move = useCallback(
    (delta: number) => {
      setSelected(s => (items.length ? (s + delta + items.length) % items.length : 0));
    },
    [items.length],
  );

  /** 应用指定下标的补全项，返回补全后的输入框文本（越界/未打开返回 null）。 */
  const applyAt = useCallback(
    (index: number): string | null => {
      const item = items[index];
      if (!item || !open) {
        return null;
      }
      return applyCompletion(input, replaceFrom, item.text);
    },
    [items, open, input, replaceFrom],
  );

  /** 应用当前选中项，返回补全后的输入框文本（无可见补全时返回 null）。 */
  const applySelected = useCallback((): string | null => {
    return applyAt(selected);
  }, [applyAt, selected]);

  /** 关闭补全（Esc / 硬件返回键）。 */
  const close = useCallback(() => {
    setItems([]);
    lastInputRef.current = '';
  }, []);

  return {items, replaceFrom, selected, open, move, applyAt, applySelected, close};
}
