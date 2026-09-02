/**
 * web 打桩：@bam.tech/react-native-image-resizer（vite alias，仅 web 构建使用）。
 * 图片压缩依赖原生图像管线，浏览器中不可用：createResizedImage 一律 reject，
 * utils/media.ts 的调用方（attachImages / prepareAvatarDataUrl）有 catch 兜底。
 */

function unavailable(): Promise<never> {
  return Promise.reject(
    new Error('浏览器环境不支持图片压缩（image-resizer 打桩）'),
  );
}

const ImageResizer = {
  createResizedImage: unavailable,
};

export default ImageResizer;
