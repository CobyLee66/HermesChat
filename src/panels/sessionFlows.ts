/**
 * sessionFlows — 会话打开/新建的业务流程（手机 SessionListScreen 与桌面
 * 会话列共用）。只做 store 操作与 foreign/fork 分流，不碰导航：
 * 成功后返回 {sessionId, title}，由调用方决定导航（手机 push / 桌面选中）。
 */

import {getExecRemote} from '../ssh/execRemote';
import {fetchRemoteHistory} from '../ssh/remoteHistory';
import {useChatStore} from '../store/chat';
import {getFork} from '../store/forkMap';
import {useProfilesStore} from '../store/profiles';
import {useSessionsStore} from '../store/sessions';
import {alertError, confirmDialog} from '../utils/alert';
import type {SessionListRow} from '../rpc/types';

export interface OpenedSession {
  sessionId: string;
  title: string;
}

/** 新建会话（session.create + chat store attach）。 */
export async function createSessionFlow(profile: string): Promise<OpenedSession> {
  const result = await useSessionsStore.getState().create(profile);
  useChatStore.getState().attach(result.session_id, {
    messages: result.messages ?? [],
    info: result.info,
    profile,
    storedSessionId: result.stored_session_id,
  });
  return {sessionId: result.session_id, title: '新会话'};
}

/**
 * 打开已有会话。foreign 会话（multiplex 大库，物理不在本 profile 库）：
 * 有 fork 记录 → fork 是 own 会话，走正常 resume；否则不 resume（避免错
 * 人格 agent），经 SSH exec 只读 sqlite 展示，首次发送时再派生。
 */
export async function openSessionFlow(
  profile: string,
  row: SessionListRow,
): Promise<OpenedSession> {
  const title = row.title || '会话';
  const {resume} = useSessionsStore.getState();
  const attach = useChatStore.getState().attach;

  if (row.namespaced && row.hostProfile && row.hostProfile !== profile) {
    const fork = await getFork(row.id, profile);
    if (fork) {
      const result = await resume(profile, fork.forkId);
      attach(result.session_id, {
        messages: result.messages ?? [],
        info: result.info,
        profile,
        storedSessionId: result.stored_session_id ?? fork.forkId,
        pendingApprovals: result.pending_approval,
        pendingClarifies: result.pending_clarify,
        running: result.running,
        inflight: result.inflight,
      });
      return {sessionId: result.session_id, title};
    }
    const exec = getExecRemote();
    const hostPath = useProfilesStore
      .getState()
      .list.find(p => p.name === row.hostProfile)?.path;
    if (!exec || !hostPath) {
      throw new Error('需要 SSH 连接才能读取该会话的历史');
    }
    const messages = await fetchRemoteHistory(exec, `${hostPath}/state.db`, row.id);
    attach(row.id, {
      messages,
      profile,
      storedSessionId: row.id,
      foreign: {originId: row.id, hostProfile: row.hostProfile},
    });
    return {sessionId: row.id, title};
  }

  const result = await resume(profile, row.id);
  const liveSid = result.session_id;
  attach(liveSid, {
    messages: result.messages ?? [],
    info: result.info,
    profile,
    storedSessionId: result.stored_session_id ?? row.id,
    pendingApprovals: result.pending_approval,
    pendingClarifies: result.pending_clarify,
    // turn 进行中（如 cron/QQ 侧发起的回合）：恢复流式尾部实时续流
    running: result.running,
    inflight: result.inflight,
  });
  return {sessionId: liveSid, title};
}

/** 删除会话（确认框 → remove），手机长按与桌面右键菜单共用。 */
export async function deleteSessionFlow(
  profile: string,
  sessionId: string,
  title: string,
): Promise<void> {
  const ok = await confirmDialog(
    '删除会话',
    `确定删除「${title || '未命名会话'}」吗？`,
  );
  if (!ok) {
    return;
  }
  try {
    await useSessionsStore.getState().remove(profile, sessionId);
  } catch (e) {
    alertError('删除失败', e instanceof Error ? e.message : String(e));
  }
}
