/**
 * 应用级常量：版本号（package.json 为显示唯一来源，原生 versionName/
 * MARKETING_VERSION 发版时按 PROGRESS.md 约定三处对齐）与项目主页链接。
 */

import {version} from '../package.json';

export const APP_VERSION: string = version;
export const APP_NAME = 'HermesChat';
export const GITHUB_REPO_URL = 'https://github.com/CobyLee66/HermesChat';
export const GITHUB_RELEASES_URL = `${GITHUB_REPO_URL}/releases`;
export const GITHUB_ISSUES_URL = `${GITHUB_REPO_URL}/issues`;
export const GITHUB_LICENSE_URL = `${GITHUB_REPO_URL}/blob/main/LICENSE`;
export const LICENSE_NAME = 'AGPL-3.0-or-later';
