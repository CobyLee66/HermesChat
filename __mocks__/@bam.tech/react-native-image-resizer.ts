/**
 * @bam.tech/react-native-image-resizer 的 jest mock。
 * 默认返回 1KB 的"压缩产物"，测试里可用 (createResizedImage as jest.Mock) 覆盖。
 */
export default {
  createResizedImage: jest.fn(
    async (
      _uri: string,
      width: number,
      height: number,
      _format: string,
      _quality: number,
    ) => ({
      path: '/tmp/caches/resized.jpg',
      uri: 'file:///tmp/caches/resized.jpg',
      name: 'resized.jpg',
      size: 1024,
      width: Math.min(width, 100),
      height: Math.min(height, 100),
    }),
  ),
};
