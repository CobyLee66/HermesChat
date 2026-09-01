import React, {useEffect} from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {
  pick,
  keepLocalCopy,
  types,
  errorCodes,
  isErrorWithCode,
} from '@react-native-documents/picker';
import RNFS from 'react-native-fs';

import {useConnectionStore} from '../store/connection';
import {Colors} from '../components/theme';
import type {RootStackParamList} from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'ConnectionSetup'>;

export function ConnectionSetupScreen() {
  const navigation = useNavigation<Nav>();
  const {config, setConfig, state, error, connect, loadPersisted} =
    useConnectionStore();
  const [keyFileName, setKeyFileName] = React.useState('');

  const pickKeyFile = async () => {
    try {
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
      setConfig({privateKey: content});
      setKeyFileName(res.name ?? '已选择');
    } catch (e) {
      if (isErrorWithCode(e) && e.code === errorCodes.OPERATION_CANCELED) {
        return;
      }
      Alert.alert('读取密钥文件失败', String(e));
    }
  };

  useEffect(() => {
    loadPersisted();
  }, [loadPersisted]);

  useEffect(() => {
    if (state === 'ready') {
      navigation.replace('ProfileList');
    }
  }, [state, navigation]);

  const connecting = state === 'connecting' || state === 'bootstrapping';

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.logo}>Hermes</Text>
        <Text style={styles.subtitle}>连接到你的 Hermes Agent</Text>

        <View style={styles.rowBetween}>
          <Text style={styles.label}>开发直连（127.0.0.1:9119）</Text>
          <Switch
            value={config.direct}
            onValueChange={v => setConfig({direct: v})}
            trackColor={{true: Colors.accent}}
          />
        </View>

        {config.direct ? (
          <>
            <Text style={styles.label}>主机</Text>
            <TextInput
              style={styles.input}
              value={config.directHost}
              onChangeText={v => setConfig({directHost: v})}
              placeholder="127.0.0.1"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.label}>端口</Text>
            <TextInput
              style={styles.input}
              value={config.directPort}
              onChangeText={v => setConfig({directPort: v})}
              placeholder="9119"
              keyboardType="number-pad"
              autoCapitalize="none"
            />
            <Text style={styles.label}>Token（可空，自动从页面提取）</Text>
            <TextInput
              style={styles.input}
              value={config.directToken}
              onChangeText={v => setConfig({directToken: v})}
              placeholder="留空自动提取"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </>
        ) : (
          <>
            <Text style={styles.label}>SSH 主机</Text>
            <TextInput
              style={styles.input}
              value={config.host}
              onChangeText={v => setConfig({host: v})}
              placeholder="例如 192.168.1.10"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.row}>
              <View style={styles.flex2}>
                <Text style={styles.label}>端口</Text>
                <TextInput
                  style={styles.input}
                  value={config.port}
                  onChangeText={v => setConfig({port: v})}
                  placeholder="22"
                  keyboardType="number-pad"
                />
              </View>
              <View style={styles.flex3}>
                <Text style={styles.label}>用户名</Text>
                <TextInput
                  style={styles.input}
                  value={config.username}
                  onChangeText={v => setConfig({username: v})}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            </View>
            <Text style={styles.label}>密码（仅存内存）</Text>
            <TextInput
              style={styles.input}
              value={config.password}
              onChangeText={v => setConfig({password: v})}
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
                  {keyFileName ? `已选: ${keyFileName}` : '选择密钥文件'}
                </Text>
              </TouchableOpacity>
            </View>
            <TextInput
              style={[styles.input, styles.multiline]}
              value={config.privateKey}
              onChangeText={v => {
                setConfig({privateKey: v});
                if (!v) setKeyFileName('');
              }}
              placeholder="粘贴 PEM 内容，或点上方按钮选择文件"
              multiline
              autoCapitalize="none"
              autoCorrect={false}
            />
            {config.privateKey ? (
              <>
                <Text style={styles.label}>私钥口令（可选）</Text>
                <TextInput
                  style={styles.input}
                  value={config.passphrase}
                  onChangeText={v => setConfig({passphrase: v})}
                  secureTextEntry
                  autoCapitalize="none"
                />
              </>
            ) : null}
          </>
        )}

        {error ? <Text style={styles.error}>⚠ {error}</Text> : null}

        <TouchableOpacity
          style={[styles.button, connecting && styles.buttonDisabled]}
          disabled={connecting}
          onPress={() => {
            connect();
          }}
          activeOpacity={0.8}>
          {connecting ? (
            <ActivityIndicator color="#FFF" />
          ) : (
            <Text style={styles.buttonText}>连接</Text>
          )}
        </TouchableOpacity>

        {state === 'reconnecting' ? (
          <Text style={styles.reconnecting}>连接已断开，正在重连…</Text>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {flex: 1, backgroundColor: Colors.bg},
  container: {padding: 24, paddingTop: 60},
  logo: {
    fontSize: 34,
    fontWeight: '700',
    color: Colors.accent,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: 6,
    marginBottom: 28,
  },
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
  button: {
    backgroundColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 10,
  },
  buttonDisabled: {opacity: 0.6},
  buttonText: {color: '#FFF', fontSize: 16, fontWeight: '600'},
  error: {color: Colors.danger, fontSize: 13, marginBottom: 4},
  reconnecting: {
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: 12,
  },
});
