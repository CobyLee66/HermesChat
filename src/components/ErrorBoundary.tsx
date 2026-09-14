/**
 * ErrorBoundary — 渲染层兜底（桌面端白屏排查的诊断手段）。
 *
 * React render 异常默认卸载整棵树 → 整窗静默空白。捕获后写诊断日志，
 * 并把白屏变成可见的错误摘要 + 「重新加载」按钮。
 * 刻意不依赖 theme/store：若崩溃源正是这些模块，兜底界面也必须能渲染。
 */

import React from 'react';
import {Platform, StyleSheet, Text, TouchableOpacity, View} from 'react-native';

import {t} from '../i18n';
import {dlog} from '../utils/desktopLog';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = {error: null};

  static getDerivedStateFromError(error: Error): State {
    return {error};
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    dlog('ERROR', `React render 异常：${error.message}\n${info.componentStack ?? ''}`);
  }

  override render(): React.ReactNode {
    const {error} = this.state;
    if (!error) {
      return this.props.children;
    }
    // 头注释约定：兜底 UI 刻意不依赖 theme/store。t() 内部读 zustand——
    // 若崩溃源恰是它，回退英文兜底文案，保证错误界面本身可渲染
    let titleText = 'Something went wrong';
    let reloadText = 'Reload';
    try {
      titleText = t('errorBoundary.title');
      reloadText = t('errorBoundary.reload');
    } catch {
      // ignore
    }
    return (
      <View style={styles.container}>
        <Text style={styles.title}>{titleText}</Text>
        <Text style={styles.message} numberOfLines={8}>
          {error.message}
        </Text>
        <TouchableOpacity
          style={styles.button}
          onPress={() => {
            if (Platform.OS === 'web') {
              (globalThis as {location?: {reload(): void}}).location?.reload();
            } else {
              this.setState({error: null});
            }
          }}>
          <Text style={styles.buttonText}>{reloadText}</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f2f3f7',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333333',
    marginBottom: 8,
  },
  message: {
    fontSize: 12,
    color: '#666666',
    textAlign: 'center',
    marginBottom: 16,
  },
  button: {
    backgroundColor: '#2f6fed',
    borderRadius: 6,
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 14,
  },
});
