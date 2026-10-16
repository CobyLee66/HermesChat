/**
 * sessionIdentity.ts — 会话的**跨重启身份**：`{profile}:{持久化会话 id}`。
 *
 * 为什么不能拿 live sid 当 key（本地持久化数据草稿/排队消息都踩过同一个坑）：
 * live sid 是易逝的——WS 断开超宽限被孤儿回收（ws_orphan_reap）、闲置 TTL、
 * LRU 上限、网关进程退出都会让它失效，`session.resume` 冷路径会返回一个**新
 * 的** live sid。于是任何「按 live sid 存的本地数据」在 App 退出重进后就再也
 * 认不回来（草稿不显示、排队消息不补发）。
 *
 * 持久化会话 id（`stored_session_id`，session.create/resume/list 都返回）跨
 * 重挂稳定，才是本地数据的正确归属键。带上 profile 是防 multiplex 场景下两个
 * profile 库里恰好同 id 的会话串数据（排队消息串队会把消息发进错的会话）。
 * storedId 未知时退回 live sid（退化形态，仍然比丢数据好）。
 */
export function sessionIdentityFor(
  profile: string,
  liveSid: string,
  storedId?: string | null,
): string {
  return `${profile || '-'}:${storedId || liveSid}`;
}
