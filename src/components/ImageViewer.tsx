import React, {useEffect} from 'react';
import {
  Image,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {useT} from '../i18n';

interface Props {
  uri: string;
  onClose: () => void;
}

/** 聊天原图全屏查看层：复用缩略图已解析的原始 URI，不做二次压缩。 */
export function ImageViewer({uri, onClose}: Props) {
  const t = useT();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }
    const onKey = (ev: {key?: string; preventDefault?: () => void}) => {
      if (ev.key === 'Escape') {
        ev.preventDefault?.();
        onClose();
      }
    };
    const win = (globalThis as {
      window?: {
        addEventListener?: (type: string, listener: unknown) => void;
        removeEventListener?: (type: string, listener: unknown) => void;
      };
    }).window;
    win?.addEventListener?.('keydown', onKey);
    return () => win?.removeEventListener?.('keydown', onKey);
  }, [onClose]);

  return (
    <Modal visible animationType="fade" onRequestClose={onClose}>
      <View style={styles.container}>
        <Image
          source={{uri}}
          style={styles.image}
          resizeMode="contain"
          accessibilityLabel={t('chat.viewImage')}
          testID="image-viewer-full"
        />
        <TouchableOpacity
          style={[styles.closeButton, {top: insets.top + 12}]}
          onPress={onClose}
          activeOpacity={0.8}
          accessibilityLabel={t('chat.close')}>
          <Text style={styles.closeText}>{t('chat.close')}</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#000'},
  image: {flex: 1, width: '100%', height: '100%'},
  closeButton: {
    position: 'absolute',
    right: 12,
    zIndex: 1,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  closeText: {color: '#FFF', fontSize: 14, fontWeight: '600'},
});
