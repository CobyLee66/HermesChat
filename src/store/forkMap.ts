/**
 * forkMap.ts — foreign 会话派生记录（AsyncStorage 持久化）。
 *
 * 用户在某 profile 下首次对 foreign 会话（multiplex 大库里归属该 profile、
 * 物理在其它库的会话）发消息时，客户端用
 * `session.create {parent_session_id, messages}` 派生一条 own 会话；
 * 之后打开直接 resume 该 fork（正确人格），不再重复派生。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export interface ForkEntry {
  /** 派生会话的持久化 id（session.create 的 stored_session_id） */
  forkId: string;
  /** 派生目标 profile（fork 是按目标 profile 记的） */
  profile: string;
}

const STORAGE_KEY = 'hermes.forkMap.v1';

async function readAll(): Promise<Record<string, ForkEntry>> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, ForkEntry>)
      : {};
  } catch {
    // 损坏数据视为空（下次写入覆盖）
    return {};
  }
}

/** 查原会话在指定 profile 下的派生；没有/不属于该 profile → null。 */
export async function getFork(
  originId: string,
  profile: string,
): Promise<ForkEntry | null> {
  const all = await readAll();
  const e = all[originId];
  if (!e || typeof e.forkId !== 'string' || e.profile !== profile) {
    return null;
  }
  return e;
}

export async function setFork(
  originId: string,
  profile: string,
  forkId: string,
): Promise<void> {
  const all = await readAll();
  all[originId] = {forkId, profile};
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}
