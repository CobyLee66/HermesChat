/**
 * AboutPanel — 「关于」面板（手机/桌面共用）。
 *
 * 应用名 + 版本号 + 简介 + 外部链接（GitHub 仓库 / Releases / 反馈问题）+
 * 许可证。链接统一走 openExternalUrl：Electron 桌面委托主进程
 * shell.openExternal，原生/浏览器走 Linking.openURL。
 */

import React from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import {Colors} from '../components/theme';
import {
  APP_NAME,
  APP_VERSION,
  GITHUB_ISSUES_URL,
  GITHUB_LICENSE_URL,
  GITHUB_RELEASES_URL,
  GITHUB_REPO_URL,
  LICENSE_NAME,
} from '../constants';
import {useT} from '../i18n';
import {alertError} from '../utils/alert';
import {openExternalUrl} from '../utils/openExternalUrl';

export function AboutPanel() {
  const t = useT();

  const openLink = (url: string) => {
    openExternalUrl(url).catch(e =>
      alertError(
        t('about.openFailed'),
        e instanceof Error ? e.message : String(e),
      ),
    );
  };

  const links = [
    {label: t('about.repo'), url: GITHUB_REPO_URL},
    {label: t('about.releases'), url: GITHUB_RELEASES_URL},
    {label: t('about.issues'), url: GITHUB_ISSUES_URL},
  ];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.appName}>{APP_NAME}</Text>
        <Text style={styles.version}>
          {t('about.version', {version: APP_VERSION})}
        </Text>
      </View>
      <Text style={styles.description}>{t('about.description')}</Text>

      <Text style={styles.sectionTitle}>{t('about.links')}</Text>
      <View style={styles.card}>
        {links.map((link, i) => (
          <TouchableOpacity
            key={link.url}
            style={[styles.linkRow, i > 0 ? styles.linkRowBorder : null]}
            activeOpacity={0.7}
            onPress={() => openLink(link.url)}>
            <Text style={styles.linkLabel}>{link.label}</Text>
            <Text style={styles.linkChevron}>›</Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity
        style={styles.licenseRow}
        activeOpacity={0.7}
        onPress={() => openLink(GITHUB_LICENSE_URL)}>
        <Text style={styles.licenseText}>
          {t('about.license')}：{LICENSE_NAME}
        </Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: Colors.bg},
  content: {paddingHorizontal: 16, paddingVertical: 24},
  header: {alignItems: 'center'},
  appName: {fontSize: 28, fontWeight: '600', color: Colors.text},
  version: {fontSize: 13, color: Colors.textSecondary, marginTop: 6},
  description: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: 16,
    lineHeight: 20,
  },
  sectionTitle: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginTop: 28,
    marginBottom: 8,
    marginLeft: 4,
  },
  card: {
    backgroundColor: Colors.card,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  linkRowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  linkLabel: {fontSize: 15, color: Colors.text},
  linkChevron: {fontSize: 18, color: Colors.textSecondary},
  licenseRow: {marginTop: 28, alignItems: 'center'},
  licenseText: {fontSize: 12, color: Colors.textSecondary},
});
