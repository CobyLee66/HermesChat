/**
 * 全局样式常量（浅色 QQ 风格）。
 */

export const Colors = {
  bg: '#F2F3F7',
  card: '#FFFFFF',
  /** 输入区可点击圆底（+ 按钮等）：比 bg 深半档，在白卡片上足以看清轮廓 */
  fill: '#EDF0F5',
  /** 比 fill 浅一档的大面积次要控件底（会话筛选/排序药丸）：白底上只略深一点，看出轮廓即可 */
  fillSubtle: '#F5F6F8',
  fillBorder: '#D9DDE6',
  /** 圆底上的主图形色（如 +/− 图标）：比 textSecondary 深一档保证可点感 */
  iconStrong: '#4E5564',
  accent: '#12B7F5',
  accentDark: '#0E9BD8',
  text: '#1A1A1A',
  textSecondary: '#8A8F99',
  border: '#E5E6EB',
  userBubble: '#B9E6FF',
  assistantBubble: '#FFFFFF',
  danger: '#F53F3F',
  dangerBg: '#FFECE8',
  thinkingBg: '#F7F8FA',
  success: '#00B42A',
  /** diff 行配色（write_file/patch 变更展示，对齐 web 端红绿口径） */
  diffAddBg: '#E9F7EE',
  diffAddText: '#0E8038',
  diffRemoveBg: '#FFEDEB',
  diffRemoveText: '#CC332B',
  diffMetaText: '#8A8F99',
};

/** 昵称首字符色块的稳定取色。 */
const AVATAR_PALETTE = [
  '#FF7D00',
  '#12B7F5',
  '#722ED1',
  '#00B42A',
  '#F5319D',
  '#0FC6C2',
  '#3491FA',
  '#F7BA1E',
];

export function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}
