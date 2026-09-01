/** 导航参数类型（独立文件，避免 screens ↔ App 循环依赖）。 */

export type RootStackParamList = {
  ConnectionHome: undefined;
  /** 新增 = 无 profileId；编辑 = 载入已有配置 */
  ConnectionEdit: {profileId?: string};
  ProfileList: undefined;
  /** profile 昵称/头像编辑（profile = profile name） */
  ProfileEdit: {profile: string};
  SessionList: {profile: string};
  Chat: {sessionId: string; profile: string; title?: string};
};
