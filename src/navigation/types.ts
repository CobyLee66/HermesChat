/** 导航参数类型（独立文件，避免 screens ↔ App 循环依赖）。 */

export type RootStackParamList = {
  ConnectionSetup: undefined;
  ProfileList: undefined;
  SessionList: {profile: string};
  Chat: {sessionId: string; profile: string; title?: string};
};
