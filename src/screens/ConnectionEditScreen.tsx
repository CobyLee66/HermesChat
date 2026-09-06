import React, {useEffect, useState} from 'react';
import {
  ScrollView,
  StyleSheet,
  Switch,
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
  type ConnectionProfile,
} from '../store/connection';
import {Colors} from '../components/theme';
import {hasDesktopBridge} from '../ssh/desktopHermesSsh';
import {desktopPickTextFile} from '../desktop/desktopMedia';
import {alertError} from '../utils/alert';
import {useKeyboardHeight} from '../utils/useKeyboardHeight';
import type {RootStackParamList} from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'ConnectionEdit'>;
type EditRoute = RouteProp<RootStackParamList, 'ConnectionEdit'>;

type ProfileForm = Omit<ConnectionProfile, 'id'>;

export function ConnectionEditScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<EditRoute>();
  const {bottomPad} = useKeyboardHeight();
  const profileId = route.params?.profileId;
  const {
    profiles,
    autoProfileId,
    state,
    addProfile,
    updateProfile,
    setAutoProfile,
  } = useConnectionStore();

  const existing = profileId
    ? profiles.find(p => p.id === profileId)
    : undefined;
  const [form, setForm] = useState<ProfileForm>(() =>
    existing ? {...existing} : {...EMPTY_PROFILE},
  );
  const [auto, setAuto] = useState(
    existing ? autoProfileId === existing.id : false,
  );

  const patch = (p: Partial<ProfileForm>) => setForm(f => ({...f, ...p}));

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
        patch({privateKey: picked.content, keyFileName: picked.name});
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
      patch({privateKey: content, keyFileName: res.name ?? '已选择'});
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
    let id = profileId ?? null;
    if (id) {
      updateProfile(id, data);
    } else {
      id = addProfile(data).id;
    }
    // 自动连接全局唯一：开 = 顶替旧配置；关 = 若自己正是自动项则清除
    if (auto) {
      setAutoProfile(id);
    } else if (autoProfileId === id) {
      setAutoProfile(null);
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
          placeholder="例如：公司服务器"
          autoCorrect={false}
        />

        <Text style={styles.label}>SSH 主机</Text>
        <TextInput
          style={styles.input}
          value={form.host}
          onChangeText={v => patch({host: v})}
          placeholder="例如 192.168.1.10"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={styles.row}>
          <View style={styles.flex2}>
            <Text style={styles.label}>端口</Text>
            <TextInput
              style={styles.input}
              value={form.port}
              onChangeText={v => patch({port: v})}
              placeholder="22"
              keyboardType="number-pad"
            />
          </View>
          <View style={styles.flex3}>
            <Text style={styles.label}>用户名</Text>
            <TextInput
              style={styles.input}
              value={form.username}
              onChangeText={v => patch({username: v})}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </View>
        <Text style={styles.label}>密码</Text>
        <TextInput
          style={styles.input}
          value={form.password}
          onChangeText={v => patch({password: v})}
          placeholder="使用私钥时可留空"
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
          style={[styles.input, styles.multiline]}
          value={form.privateKey}
          onChangeText={v => {
            patch(v ? {privateKey: v} : {privateKey: '', keyFileName: ''});
          }}
          placeholder="粘贴 PEM 内容，或点上方按钮选择文件"
          multiline
          autoCapitalize="none"
          autoCorrect={false}
        />
        {form.privateKey ? (
          <>
            <Text style={styles.label}>私钥口令（可选）</Text>
            <TextInput
              style={styles.input}
              value={form.passphrase}
              onChangeText={v => patch({passphrase: v})}
              secureTextEntry
              autoCapitalize="none"
            />
          </>
        ) : null}

        <View style={styles.rowBetween}>
          <Text style={styles.label}>打开应用后自动连接</Text>
          <Switch
            value={auto}
            onValueChange={setAuto}
            trackColor={{true: Colors.accent}}
          />
        </View>
        <Text style={styles.hint}>自动连接全局仅一个，开启后会替换原有配置</Text>

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
  row: {flexDirection: 'row', gap: 12},
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
