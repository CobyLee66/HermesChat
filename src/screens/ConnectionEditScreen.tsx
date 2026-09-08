import React, {useEffect, useState} from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  useNavigation,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {
  pick,
  keepLocalCopy,
  types,
  errorCodes,
  isErrorWithCode,
} from '@react-native-documents/picker';
import RNFS from 'react-native-fs';

import {
  EMPTY_PROFILE,
  useConnectionStore,
  type ConnectionType,
} from '../store/connection';
import {Colors} from '../components/theme';
import {hasDesktopBridge} from '../ssh/desktopHermesSsh';
import {desktopPickTextFile} from '../desktop/desktopMedia';
import {alertError} from '../utils/alert';
import {
  formatProfileErrors,
  validateProfileForm,
  type ProfileForm,
  type ProfileFormErrors,
} from '../utils/profileValidation';
import {useKeyboardHeight} from '../utils/useKeyboardHeight';
import type {RootStackParamList} from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'ConnectionEdit'>;
type EditRoute = RouteProp<RootStackParamList, 'ConnectionEdit'>;

export function ConnectionEditScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<EditRoute>();
  const {bottomPad} = useKeyboardHeight();
  const profileId = route.params?.profileId;
  const {
    profiles,
    state,
    addProfile,
    updateProfile,
  } = useConnectionStore();

  const existing = profileId
    ? profiles.find(p => p.id === profileId)
    : undefined;
  const [form, setForm] = useState<ProfileForm>(() =>
    existing ? {...existing} : {...EMPTY_PROFILE},
  );
  const [errors, setErrors] = useState<ProfileFormErrors>({});

  const patch = (p: Partial<ProfileForm>) => setForm(f => ({...f, ...p}));

  /** 更新表单并清除指定字段的错误标注（用户改正后红框/红字即时消失） */
  const patchClearing = (
    p: Partial<ProfileForm>,
    keys: (keyof ProfileFormErrors)[],
  ) => {
    setForm(f => ({...f, ...p}));
    setErrors(prev => {
      if (!keys.some(k => prev[k])) {
        return prev;
      }
      const next = {...prev};
      for (const k of keys) {
        delete next[k];
      }
      return next;
    });
  };

  /** 出错字段的输入框红边框 */
  const inputStyle = (err: string | undefined) =>
    err ? [styles.input, styles.inputError] : styles.input;

  /** 字段下方的红字错误提示 */
  const fieldError = (err: string | undefined) =>
    err ? <Text style={styles.errorText}>{err}</Text> : null;

  /** 切换连接类型：直连模式下 host/port 代填 gateway 默认值，SSH 亦然 */
  const switchType = (t: ConnectionType) => {
    if (t === form.type) {
      return;
    }
    setErrors({});
    if (t === 'direct') {
      patch({
        type: 'direct',
        host: form.host.trim() ? form.host : '127.0.0.1',
        port: !form.port.trim() || form.port === '22' ? '9119' : form.port,
      });
    } else {
      patch({type: 'ssh', port: form.port === '9119' ? '22' : form.port});
    }
  };

  useEffect(() => {
    if (state === 'ready') {
      navigation.replace('ProfileList');
    }
  }, [state, navigation]);

  const pickKeyFile = async () => {
    try {
      if (hasDesktopBridge()) {
        // 桌面：系统对话框选文件 → 主进程读 utf8（PEM 文本）
        const picked = await desktopPickTextFile();
        if (!picked) {
          return;
        }
        patchClearing({privateKey: picked.content, keyFileName: picked.name}, [
          'auth',
        ]);
        return;
      }
      const [res] = await pick({type: [types.allFiles]});
      if (!res) return;
      const [copy] = await keepLocalCopy({
        files: [{uri: res.uri, fileName: res.name ?? 'ssh_key'}],
        destination: 'cachesDirectory',
      });
      if (copy.status !== 'success') {
        throw new Error(copy.copyError);
      }
      const content = await RNFS.readFile(copy.localUri, 'utf8');
      patchClearing({privateKey: content, keyFileName: res.name ?? '已选择'}, [
        'auth',
      ]);
    } catch (e) {
      if (
        !hasDesktopBridge() &&
        isErrorWithCode(e) &&
        e.code === errorCodes.OPERATION_CANCELED
      ) {
        return;
      }
      alertError(
        '读取密钥文件失败',
        e instanceof Error ? e.message : String(e),
      );
    }
  };

  const save = () => {
    const data: ProfileForm = {
      ...form,
      name: form.name.trim() || form.host.trim() || '未命名配置',
      host: form.host.trim(),
      username: form.username.trim(),
    };
    const errs = validateProfileForm(data);
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      alertError('无法保存', formatProfileErrors(errs));
      return;
    }
    let id = profileId ?? null;
    if (id) {
      updateProfile(id, data);
    } else {
      id = addProfile(data).id;
    }
    navigation.goBack();
  };

  return (
    <View style={styles.flex}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.container,
          {paddingBottom: bottomPad},
        ]}>
        <Text style={styles.label}>配置名称</Text>
        <TextInput
          style={styles.input}
          value={form.name}
          onChangeText={v => patch({name: v})}
          placeholder={form.type === 'direct' ? '例如：本机 gateway' : '例如：公司服务器'}
          placeholderTextColor={Colors.textSecondary}
          autoCorrect={false}
        />

        <Text style={styles.label}>连接类型</Text>
        <View style={styles.typeRow}>
          <TouchableOpacity
            style={[styles.typeBtn, form.type === 'ssh' && styles.typeBtnActive]}
            onPress={() => switchType('ssh')}
            activeOpacity={0.8}>
            <Text
              style={[
                styles.typeBtnText,
                form.type === 'ssh' && styles.typeBtnTextActive,
              ]}>
              SSH 隧道
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.typeBtn,
              form.type === 'direct' && styles.typeBtnActive,
            ]}
            onPress={() => switchType('direct')}
            activeOpacity={0.8}>
            <Text
              style={[
                styles.typeBtnText,
                form.type === 'direct' && styles.typeBtnTextActive,
              ]}>
              直连
            </Text>
          </TouchableOpacity>
        </View>

        {form.type === 'direct' ? (
          <>
            <Text style={styles.label}>Gateway 主机</Text>
            <TextInput
              style={inputStyle(errors.host)}
              value={form.host}
              onChangeText={v => patchClearing({host: v}, ['host'])}
              placeholder="127.0.0.1"
              placeholderTextColor={Colors.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {fieldError(errors.host)}
            <Text style={styles.label}>端口</Text>
            <TextInput
              style={inputStyle(errors.port)}
              value={form.port}
              onChangeText={v => patchClearing({port: v}, ['port'])}
              placeholder="9119"
              placeholderTextColor={Colors.textSecondary}
              keyboardType="number-pad"
            />
            {fieldError(errors.port)}
            <Text style={styles.label}>Session Token（可选）</Text>
            <TextInput
              style={styles.input}
              value={form.token}
              onChangeText={v => patch({token: v})}
              placeholder="留空则自动从 gateway 首页提取"
              placeholderTextColor={Colors.textSecondary}
              secureTextEntry
              autoCapitalize="none"
            />
            <Text style={styles.hint}>
              需 gateway 已在该地址监听；局域网设备直连需 hermes serve 监听
              0.0.0.0
            </Text>
            {Platform.OS === 'web' && !hasDesktopBridge() ? (
              <Text style={styles.hint}>
                浏览器环境受跨源限制，仅支持本机 127.0.0.1:9119（经开发服务器代理）
              </Text>
            ) : null}
          </>
        ) : (
          <>
            <Text style={styles.label}>SSH 主机</Text>
            <TextInput
              style={inputStyle(errors.host)}
              value={form.host}
              onChangeText={v => patchClearing({host: v}, ['host'])}
              placeholder="例如 192.168.1.10"
              placeholderTextColor={Colors.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {fieldError(errors.host)}
            <View style={styles.row}>
              <View style={styles.flex2}>
                <Text style={styles.label}>端口</Text>
                <TextInput
                  style={inputStyle(errors.port)}
                  value={form.port}
                  onChangeText={v => patchClearing({port: v}, ['port'])}
                  placeholder="22"
                  placeholderTextColor={Colors.textSecondary}
                  keyboardType="number-pad"
                />
                {fieldError(errors.port)}
              </View>
              <View style={styles.flex3}>
                <Text style={styles.label}>用户名</Text>
                <TextInput
                  style={inputStyle(errors.username)}
                  value={form.username}
                  onChangeText={v => patchClearing({username: v}, ['username'])}
                  placeholder="例如 root"
                  placeholderTextColor={Colors.textSecondary}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {fieldError(errors.username)}
              </View>
            </View>
            <Text style={styles.label}>密码</Text>
            <TextInput
              style={inputStyle(errors.auth)}
              value={form.password}
              onChangeText={v => patchClearing({password: v}, ['auth'])}
              placeholder="使用私钥时可留空"
              placeholderTextColor={Colors.textSecondary}
              secureTextEntry
              autoCapitalize="none"
            />
            <View style={styles.rowBetween}>
              <Text style={styles.label}>私钥（可选，优先于密码）</Text>
              <TouchableOpacity
                style={styles.smallButton}
                onPress={pickKeyFile}
                activeOpacity={0.8}>
                <Text style={styles.smallButtonText} numberOfLines={1}>
                  {form.keyFileName ? `已选: ${form.keyFileName}` : '选择密钥文件'}
                </Text>
              </TouchableOpacity>
            </View>
            <TextInput
              style={[
                styles.input,
                styles.multiline,
                errors.auth ? styles.inputError : null,
              ]}
              value={form.privateKey}
              onChangeText={v => {
                patchClearing(
                  v ? {privateKey: v} : {privateKey: '', keyFileName: ''},
                  ['auth'],
                );
              }}
              placeholder="粘贴 PEM 内容，或点上方按钮选择文件"
              placeholderTextColor={Colors.textSecondary}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
            />
            {fieldError(errors.auth)}
            {form.privateKey ? (
              <>
                <Text style={styles.label}>私钥口令（可选）</Text>
                <TextInput
                  style={styles.input}
                  value={form.passphrase}
                  onChangeText={v => patch({passphrase: v})}
                  placeholder="密钥有口令时填写"
                  placeholderTextColor={Colors.textSecondary}
                  secureTextEntry
                  autoCapitalize="none"
                />
              </>
            ) : null}
          </>
        )}

        <TouchableOpacity
          style={styles.button}
          onPress={save}
          activeOpacity={0.8}>
          <Text style={styles.buttonText}>保存</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {flex: 1, backgroundColor: Colors.bg},
  container: {padding: 24, paddingTop: 20},
  label: {fontSize: 13, color: Colors.textSecondary, marginBottom: 6},
  input: {
    backgroundColor: Colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: Colors.text,
    marginBottom: 14,
  },
  multiline: {minHeight: 80, textAlignVertical: 'top'},
  inputError: {borderColor: Colors.danger},
  errorText: {
    fontSize: 12,
    color: Colors.danger,
    marginTop: -10,
    marginBottom: 16,
  },
  row: {flexDirection: 'row', gap: 12},
  typeRow: {flexDirection: 'row', gap: 8, marginBottom: 16},
  typeBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    alignItems: 'center',
  },
  typeBtnActive: {borderColor: Colors.accent, borderWidth: 2},
  typeBtnText: {fontSize: 14, color: Colors.textSecondary},
  typeBtnTextActive: {color: Colors.accentDark, fontWeight: '600'},
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  smallButton: {
    backgroundColor: Colors.card,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.accent,
    paddingHorizontal: 10,
    paddingVertical: 5,
    maxWidth: 180,
  },
  smallButtonText: {color: Colors.accent, fontSize: 12},
  flex2: {flex: 2},
  flex3: {flex: 3},
  hint: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: -10,
    marginBottom: 16,
  },
  button: {
    backgroundColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 10,
  },
  buttonText: {color: '#FFF', fontSize: 16, fontWeight: '600'},
});
