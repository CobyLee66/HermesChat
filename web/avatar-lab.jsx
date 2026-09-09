/**
 * avatar-lab.jsx — 头像「深色圆角线框」最小复现实验页（临时诊断用，非产品代码）。
 *
 * 背景：存量头像文件边缘像素已证干净（ffmpeg 灰度剖面 223~255），但截图/真机
 * 均可见深色圆角线框 → 显示栈嫌疑。本页用确定纯净的合成白 JPEG 喂各种
 * Avatar 结构变体：若纯白图上仍出现线框即为渲染产物，变体对照锁定肇因层。
 *
 * 访问：vite dev（5188）下 /avatar-lab.html；配合 /tmp/avatar-lab-shot.js 截图。
 */
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Image, StyleSheet, Text, View} from 'react-native';

import {Avatar} from '../src/components/Avatar.tsx';
import {avatarColor} from '../src/components/theme.ts';

const SIZE = 46;
const RADIUS = Math.round(SIZE * 0.22);
const NAME = '某 profile';
const PASTEL = avatarColor(NAME);

// 合成 512×512 纯白 JPEG（内容确定干净，任何暗框皆非文件自带）
function whiteJpegDataUrl() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, 512, 512);
  return canvas.toDataURL('image/jpeg', 0.9);
}

function blobUrlOf(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf('base64,') + 7);
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return URL.createObjectURL(new Blob([bytes], {type: 'image/jpeg'}));
}

const dataUrl = whiteJpegDataUrl();
const blobUrl = blobUrlOf(dataUrl);

// 变体：结构与 Avatar.tsx 逐层拆解
const variants = [
  {
    key: 'avatar-data',
    label: 'Avatar 组件（data URL，带渐现动画）',
    node: <Avatar name={NAME} uri={dataUrl} size={SIZE} />,
  },
  {
    key: 'avatar-blob',
    label: 'Avatar 组件（blob URL，即显路径=App 真实路径）',
    node: <Avatar name={NAME} uri={blobUrl} size={SIZE} />,
  },
  {
    key: 'static-double',
    label: '双层 radius 静态（外 View bg+r + 内 Image r），无动画',
    node: (
      <View
        style={{
          width: SIZE,
          height: SIZE,
          borderRadius: RADIUS,
          backgroundColor: PASTEL,
        }}>
        <Image
          source={{uri: blobUrl}}
          style={{width: '100%', height: '100%', borderRadius: RADIUS}}
        />
      </View>
    ),
  },
  {
    key: 'outer-only',
    label: '仅外层 radius（overflow hidden），内层无 radius',
    node: (
      <View
        style={{
          width: SIZE,
          height: SIZE,
          borderRadius: RADIUS,
          overflow: 'hidden',
          backgroundColor: PASTEL,
        }}>
        <Image source={{uri: blobUrl}} style={{width: '100%', height: '100%'}} />
      </View>
    ),
  },
  {
    key: 'inner-only',
    label: '仅内层 Image radius，外层无 bg',
    node: (
      <View style={{width: SIZE, height: SIZE}}>
        <Image
          source={{uri: blobUrl}}
          style={{width: '100%', height: '100%', borderRadius: RADIUS}}
        />
      </View>
    ),
  },
  {
    key: 'plain-img',
    label: '裸 <img> + border-radius（绕开 RNW）',
    node: (
      <img
        src={blobUrl}
        style={{
          width: SIZE,
          height: SIZE,
          borderRadius: RADIUS,
          display: 'block',
        }}
      />
    ),
  },
];

function Cell({variant}) {
  return (
    <div
      id={`cell-${variant.key}`}
      style={{display: 'inline-block', margin: '14px 18px 4px 14px'}}>
      <div style={{width: SIZE, height: SIZE}}>{variant.node}</div>
      <div
        style={{
          fontSize: 11,
          color: '#555',
          maxWidth: 190,
          marginTop: 6,
          fontFamily: 'system-ui',
        }}>
        {variant.label}
      </div>
    </div>
  );
}

function Row({bg, title}) {
  return (
    <div style={{background: bg, padding: '10px 16px'}}>
      <div style={{fontSize: 13, fontWeight: 600, color: '#333'}}>
        页面底色 {title}
      </div>
      <div>
        {variants.map(v => (
          <Cell key={`${bg}-${v.key}`} variant={v} />
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <div>
    <Row bg="#f2f3f7" title="#F2F3F7（App bg）" />
    <Row bg="#ffffff" title="#FFFFFF" />
  </div>,
);
