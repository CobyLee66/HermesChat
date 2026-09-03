/**
 * profile 编辑页：头像（更换/恢复默认）+ 昵称。
 * 头像操作即时生效（各自独立 RPC）；昵称由"保存"按钮提交。
 */

import React, {useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {useRoute, type RouteProp} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {
  pick,
  keepLocalCopy,
  types,
  errorCodes,
  isErrorWithCode,
} from '@react-native-documents/picker';

import {Avatar} from '../components/Avatar';
import {Colors} from '../components/theme';
import {useConnectionStore} from '../store/connection';
import {useProfilesStore} from '../store/profiles';
import {deleteTempFile, prepareAvatarDataUrl} from '../utils/media';
import type {RootStackParamList} from '../navigation/types';

type Rt = RouteProp<RootStackParamList, 'ProfileEdit'>;

export function ProfileEditScreen() {
  const route = useRoute<Rt>();
  const profileName = route.params.profile;
  const insets = useSafeAreaInsets();

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
      setBusy('avatar');
      let dataUrl: string;
      try {
        dataUrl = await prepareAvatarDataUrl(copy.localUri);
      } finally {
        // picker 副本（keepLocalCopy）用完即删，避免缓存目录堆积
        await deleteTempFile(copy.localUri);
      }
      // 选图期间 App 退后台可能断线重连中：等连接就绪再发 RPC，
      // 否则偶发 "rpc not connected"
      await useConnectionStore.getState().waitReady();
      await setAvatar(profileName, dataUrl);
      setPreviewUri(dataUrl);
    } catch (e) {
      if (isErrorWithCode(e) && e.code === errorCodes.OPERATION_CANCELED) {
        return;
      }
      Alert.alert('更换头像失败', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onClearAvatar = () => {
    Alert.alert('恢复默认头像', '将删除自定义头像，使用昵称首字符色块。', [
      {text: '取消', style: 'cancel'},
      {
        text: '恢复默认',
        style: 'destructive',
        onPress: async () => {
          try {
            setBusy('clear');
            await clearAvatar(profileName);
            setPreviewUri(null);
          } catch (e) {
            Alert.alert(
              '操作失败',
              e instanceof Error ? e.message : String(e),
            );
          } finally {
            setBusy(null);
          }
        },
      },
    ]);
  };

  const onSaveNickname = async () => {
    try {
      setBusy('nickname');
      await updateNickname(profileName, nickname);
      Alert.alert('已保存', '昵称已更新');
    } catch (e) {
      Alert.alert('保存失败', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const shownAvatar = previewUri ?? avatarUri;
  const displayName = nickname.trim() || fallbackName;

  return (
    <KeyboardAvoidingView style={styles.flex} behavior="padding">
      <ScrollView
        contentContainerStyle={[
          styles.container,
          {paddingBottom: insets.bottom},
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
            <Text style={styles.btnText}>更换头像</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, styles.btnGhost]}
            onPress={onClearAvatar}
            disabled={busy !== null}
            activeOpacity={0.8}>
            <Text style={[styles.btnText, styles.btnGhostText]}>恢复默认</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.label}>昵称</Text>
        <TextInput
          style={styles.input}
          value={nickname}
          onChangeText={setNickname}
          placeholder={fallbackName}
          placeholderTextColor={Colors.textSecondary}
          maxLength={40}
        />
        <Text style={styles.hint}>留空则使用默认显示名（{fallbackName}）</Text>

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
            <Text style={styles.btnText}>保存</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
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
