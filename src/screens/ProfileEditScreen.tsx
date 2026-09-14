/**
 * profile 编辑页：头像（更换/恢复默认）+ 昵称。
 * 头像操作即时生效（各自独立 RPC）；昵称由"保存"按钮提交。
 */

import React, {useState} from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {useRoute, type RouteProp} from '@react-navigation/native';
import {
  pick,
  keepLocalCopy,
  types,
  errorCodes,
  isErrorWithCode,
} from '@react-native-documents/picker';

import {Avatar} from '../components/Avatar';
import {Colors} from '../components/theme';
import {useT} from '../i18n';
import {useKeyboardHeight} from '../utils/useKeyboardHeight';
import {useConnectionStore} from '../store/connection';
import {useProfilesStore} from '../store/profiles';
import {deleteTempFile, prepareAvatarDataUrl} from '../utils/media';
import {hasDesktopBridge} from '../ssh/desktopHermesSsh';
import {desktopPickImages} from '../desktop/desktopMedia';
import {alertError, alertInfo, confirmDialog} from '../utils/alert';
import type {RootStackParamList} from '../navigation/types';

type Rt = RouteProp<RootStackParamList, 'ProfileEdit'>;

export function ProfileEditScreen() {
  const route = useRoute<Rt>();
  const t = useT();
  const profileName = route.params.profile;
  const {bottomPad} = useKeyboardHeight();

  const profile = useProfilesStore(s =>
    s.list.find(p => p.name === profileName),
  );
  const avatarUri = useProfilesStore(s => s.avatars[profileName]);
  const {updateNickname, setAvatar, clearAvatar} = useProfilesStore();

  const meta = profile?.ui_meta as {nickname?: string} | undefined;
  const currentNickname = meta?.nickname ?? '';
  // 显示兜底顺序与列表一致：ui_meta.nickname > description 首行 > name
  const fallbackName = profile?.description?.split('\n')[0] || profileName;

  const [nickname, setNickname] = useState(currentNickname);
  const [busy, setBusy] = useState<string | null>(null);
  /** 本地预览（上传成功后立刻显示新图，不等 get_asset 重拉） */
  const [previewUri, setPreviewUri] = useState<string | null>(null);

  const onPickAvatar = async () => {
    try {
      setBusy('avatar');
      let dataUrl: string;
      if (hasDesktopBridge()) {
        // 桌面：系统对话框选图 → 主进程读 data URL → canvas 裁剪压缩
        const bridgePicked = await desktopPickImages();
        const first = bridgePicked[0];
        if (!first) {
          return;
        }
        dataUrl = await prepareAvatarDataUrl(first.uri);
      } else {
        const [res] = await pick({type: [types.images]});
        if (!res) {
          return;
        }
        const [copy] = await keepLocalCopy({
          files: [{uri: res.uri, fileName: res.name ?? 'avatar'}],
          destination: 'cachesDirectory',
        });
        if (copy.status !== 'success') {
          throw new Error(copy.copyError);
        }
        try {
          dataUrl = await prepareAvatarDataUrl(copy.localUri);
        } finally {
          // picker 副本（keepLocalCopy）用完即删，避免缓存目录堆积
          await deleteTempFile(copy.localUri);
        }
      }
      // 选图期间 App 退后台可能断线重连中：等连接就绪再发 RPC，
      // 否则偶发 "rpc not connected"
      await useConnectionStore.getState().waitReady();
      await setAvatar(profileName, dataUrl);
      setPreviewUri(dataUrl);
    } catch (e) {
      if (!hasDesktopBridge() && isErrorWithCode(e) && e.code === errorCodes.OPERATION_CANCELED) {
        return;
      }
      alertError(t('profile.avatarChangeFailed'), e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onClearAvatar = () => {
    void confirmDialog(
      t('profile.resetAvatarTitle'),
      t('profile.resetAvatarMessage'),
    ).then(ok => {
      if (!ok) {
        return;
      }
      (async () => {
        try {
          setBusy('clear');
          await clearAvatar(profileName);
          setPreviewUri(null);
        } catch (e) {
          alertError(t('common.opFailed'), e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(null);
        }
      })();
    });
  };

  const onSaveNickname = async () => {
    try {
      setBusy('nickname');
      await updateNickname(profileName, nickname);
      alertInfo(t('profile.saved'), t('profile.nicknameUpdated'));
    } catch (e) {
      alertError(t('profile.saveFailed'), e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const shownAvatar = previewUri ?? avatarUri;
  const displayName = nickname.trim() || fallbackName;

  return (
    <View style={styles.flex}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.container,
          {paddingBottom: bottomPad},
        ]}>
        <View style={styles.avatarWrap}>
          <Avatar name={displayName} uri={shownAvatar} size={96} />
          {busy === 'avatar' || busy === 'clear' ? (
            <ActivityIndicator style={styles.avatarSpin} color={Colors.accent} />
          ) : null}
        </View>

        <View style={styles.btnRow}>
          <TouchableOpacity
            style={styles.btn}
            onPress={onPickAvatar}
            disabled={busy !== null}
            activeOpacity={0.8}>
            <Text style={styles.btnText}>{t('profile.changeAvatar')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, styles.btnGhost]}
            onPress={onClearAvatar}
            disabled={busy !== null}
            activeOpacity={0.8}>
            <Text style={[styles.btnText, styles.btnGhostText]}>
              {t('profile.resetAvatar')}
            </Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.label}>{t('profile.nickname')}</Text>
        <TextInput
          style={styles.input}
          value={nickname}
          onChangeText={setNickname}
          placeholder={fallbackName}
          placeholderTextColor={Colors.textSecondary}
          maxLength={40}
        />
        <Text style={styles.hint}>
          {t('profile.nicknameHint', {name: fallbackName})}
        </Text>

        <TouchableOpacity
          style={[
            styles.btn,
            styles.saveBtn,
            busy !== null && styles.btnDisabled,
          ]}
          onPress={onSaveNickname}
          disabled={busy !== null}
          activeOpacity={0.8}>
          {busy === 'nickname' ? (
            <ActivityIndicator color="#FFF" />
          ) : (
            <Text style={styles.btnText}>{t('common.save')}</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {flex: 1, backgroundColor: Colors.bg},
  container: {padding: 20, alignItems: 'stretch'},
  avatarWrap: {alignSelf: 'center', marginTop: 12, marginBottom: 16},
  avatarSpin: {position: 'absolute', right: -24, top: '40%'},
  btnRow: {flexDirection: 'row', justifyContent: 'center', marginBottom: 24},
  btn: {
    backgroundColor: Colors.accent,
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 9,
    marginHorizontal: 6,
  },
  btnGhost: {
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  btnText: {color: '#FFF', fontSize: 14, fontWeight: '600'},
  btnGhostText: {color: Colors.text},
  btnDisabled: {opacity: 0.5},
  label: {fontSize: 13, color: Colors.textSecondary, marginBottom: 6},
  input: {
    backgroundColor: Colors.card,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: Colors.text,
  },
  hint: {fontSize: 12, color: Colors.textSecondary, marginTop: 6},
  saveBtn: {marginTop: 20, alignItems: 'center'},
});
