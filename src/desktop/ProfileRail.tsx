/**
 * ProfileRail — wide 三栏布局最左的 profile 竖条：头像列表 + 底部编辑/退出。
 */

import React from 'react';
import {ScrollView, StyleSheet, Text, TouchableOpacity, View} from 'react-native';

import {Avatar} from '../components/Avatar';
import {Colors} from '../components/theme';
import {useProfileNickname} from '../panels/SessionListPanel';
import {useProfilesStore} from '../store/profiles';
import {useConnectionStore} from '../store/connection';
import {confirmDialog} from '../utils/alert';
import {useDesktopUiStore} from './desktopUiStore';

export function ProfileRail() {
  const list = useProfilesStore(s => s.list);
  const selectedProfile = useDesktopUiStore(s => s.selectedProfile);
  const selectProfile = useDesktopUiStore(s => s.selectProfile);
  const setProfileEditOpen = useDesktopUiStore(s => s.setProfileEditOpen);

  return (
    <View style={styles.rail}>
      <ScrollView contentContainerStyle={styles.list}>
        {list.map(p => (
          <RailItem
            key={p.name}
            name={p.name}
            active={p.name === selectedProfile}
            onPress={() => selectProfile(p.name)}
          />
        ))}
      </ScrollView>
      <View style={styles.footer}>
        {selectedProfile ? (
          <TouchableOpacity
            style={styles.footerBtn}
            activeOpacity={0.7}
            onPress={() => setProfileEditOpen(selectedProfile)}>
            <Text style={styles.footerText}>编辑</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={styles.footerBtn}
          activeOpacity={0.7}
          onPress={() => {
            void confirmDialog('退出连接', '确定断开与主机的连接吗？').then(ok => {
              if (ok) {
                useConnectionStore.getState().disconnect();
              }
            });
          }}>
          <Text style={styles.footerDanger}>退出</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/** 单个竖条头像项（hook 独立成组件，避免循环内调用）。 */
function RailItem({
  name,
  active,
  onPress,
}: {
  name: string;
  active: boolean;
  onPress: () => void;
}) {
  const nickname = useProfileNickname(name);
  const avatarUri = useProfilesStore(s => s.avatars[name]);
  return (
    <TouchableOpacity
      style={[styles.item, active && styles.itemActive]}
      activeOpacity={0.7}
      onPress={onPress}>
      <Avatar name={nickname} uri={avatarUri} size={40} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  rail: {
    width: 64,
    backgroundColor: Colors.card,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: Colors.border,
  },
  list: {alignItems: 'center', paddingTop: 10, gap: 8},
  item: {
    borderRadius: 22,
    padding: 2,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  itemActive: {borderColor: Colors.accent},
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
    alignItems: 'center',
    paddingVertical: 8,
    gap: 6,
  },
  footerBtn: {paddingVertical: 4, paddingHorizontal: 8},
  footerText: {fontSize: 12, color: Colors.textSecondary},
  footerDanger: {fontSize: 12, color: Colors.danger},
});
