/**
 * Cron 定时任务 — dashboard REST 端点（/api/cron/*）。
 *
 * 与 /api/ws 同端口同进程（dashboard 9119），鉴权复用 X-Hermes-Session-Token，
 * 功能与 web dashboard 的 cron 管理页对齐（WS cron.manage 无 trigger/runs）。
 * httpUrl/token 由调用方从 useConnectionStore 取（rest.ts 同款纯函数风格）。
 */

import type {
  CronDeliveryTarget,
  CronJob,
  CronJobCreateInput,
  CronJobUpdateInput,
  CronRunRow,
} from './types';

/** 常规请求超时，与 rpc/client.ts 的 30s 对齐。 */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * trigger 是同步长操作：服务端要跑完整个 job 才返回（dashboard 桌面客户端
 * 给该端点设 24h）。App 侧放宽到 10 分钟，行级 busy 态 + cron.changed 兜底刷新。
 */
const TRIGGER_TIMEOUT_MS = 10 * 60_000;

/** 带 HTTP 状态码的错误（trigger 409=已在运行等分支处理用）。 */
export class CronHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'CronHttpError';
    this.status = status;
  }
}

function authHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(token ? {'X-Hermes-Session-Token': token} : {}),
  };
}

/** detail 可能是字符串或 FastAPI 校验数组，统一转文案。 */
function detailText(body: unknown): string | null {
  const detail = (body as {detail?: unknown} | null)?.detail;
  if (typeof detail === 'string') {
    return detail;
  }
  if (detail != null) {
    return JSON.stringify(detail);
  }
  return null;
}

export async function cronFetch<T>(
  httpUrl: string,
  token: string,
  path: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${httpUrl}${path}`, {
      ...init,
      headers: authHeaders(token),
      signal: controller.signal,
    });
    const body: unknown = await resp.json().catch(() => null);
    if (!resp.ok) {
      const fallback = `请求失败（HTTP ${resp.status}）`;
      throw new CronHttpError(resp.status, detailText(body) ?? fallback);
    }
    return body as T;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new CronHttpError(0, `请求超时（${Math.round(timeoutMs / 1000)} 秒），请检查连接后重试`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function profileQs(profile?: string): string {
  return profile ? `?profile=${encodeURIComponent(profile)}` : '';
}

function jobPath(jobId: string, suffix = ''): string {
  return `/api/cron/jobs/${encodeURIComponent(jobId)}${suffix}`;
}

/** 列出任务（缺省 profile=all 跨 profile 聚合，行上带 profile 字段）。 */
export function listCronJobs(
  httpUrl: string,
  token: string,
  profile?: string,
): Promise<CronJob[]> {
  const qs = profile
    ? `?profile=${encodeURIComponent(profile)}`
    : '?profile=all';
  return cronFetch<CronJob[]>(httpUrl, token, `/api/cron/jobs${qs}`);
}

/** 单个任务（job_id 也可传 name，服务端 resolve）。 */
export function getCronJob(
  httpUrl: string,
  token: string,
  jobId: string,
  profile?: string,
): Promise<CronJob> {
  return cronFetch<CronJob>(
    httpUrl,
    token,
    `${jobPath(jobId)}${profileQs(profile)}`,
  );
}

/** 运行历史（该 job 产生的 source=cron 会话，最新在前；limit 服务端钳制 1..100）。 */
export function getCronJobRuns(
  httpUrl: string,
  token: string,
  jobId: string,
  limit = 20,
  profile?: string,
): Promise<{runs: CronRunRow[]; limit: number}> {
  const sep = profile ? '&' : '';
  return cronFetch<{runs: CronRunRow[]; limit: number}>(
    httpUrl,
    token,
    `${jobPath(jobId, '/runs')}${profileQs(profile)}${sep}limit=${limit}`,
  );
}

export function createCronJob(
  httpUrl: string,
  token: string,
  input: CronJobCreateInput,
  profile?: string,
): Promise<CronJob> {
  return cronFetch<CronJob>(httpUrl, token, `/api/cron/jobs${profileQs(profile)}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** updates 为任意可归一化字段的 dict；可选字段传 null 显式清空。 */
export function updateCronJob(
  httpUrl: string,
  token: string,
  jobId: string,
  updates: CronJobUpdateInput,
  profile?: string,
): Promise<CronJob> {
  return cronFetch<CronJob>(httpUrl, token, `${jobPath(jobId)}${profileQs(profile)}`, {
    method: 'PUT',
    body: JSON.stringify({updates}),
  });
}

export function pauseCronJob(
  httpUrl: string,
  token: string,
  jobId: string,
  profile?: string,
): Promise<CronJob> {
  return cronFetch<CronJob>(
    httpUrl,
    token,
    `${jobPath(jobId, '/pause')}${profileQs(profile)}`,
    {method: 'POST'},
  );
}

export function resumeCronJob(
  httpUrl: string,
  token: string,
  jobId: string,
  profile?: string,
): Promise<CronJob> {
  return cronFetch<CronJob>(
    httpUrl,
    token,
    `${jobPath(jobId, '/resume')}${profileQs(profile)}`,
    {method: 'POST'},
  );
}

/** 立即运行（同步跑完整个 job 才返回；已在运行 → 409；one-shot 跑完自删返回合成记录）。 */
export function triggerCronJob(
  httpUrl: string,
  token: string,
  jobId: string,
  profile?: string,
): Promise<CronJob> {
  return cronFetch<CronJob>(
    httpUrl,
    token,
    `${jobPath(jobId, '/trigger')}${profileQs(profile)}`,
    {method: 'POST'},
    TRIGGER_TIMEOUT_MS,
  );
}

export function deleteCronJob(
  httpUrl: string,
  token: string,
  jobId: string,
  profile?: string,
): Promise<{ok: boolean}> {
  return cronFetch<{ok: boolean}>(
    httpUrl,
    token,
    `${jobPath(jobId)}${profileQs(profile)}`,
    {method: 'DELETE'},
  );
}

/** 投递目标下拉选项（始终含 local；其余来自已配置平台）。 */
export function getDeliveryTargets(
  httpUrl: string,
  token: string,
): Promise<{targets: CronDeliveryTarget[]}> {
  return cronFetch<{targets: CronDeliveryTarget[]}>(
    httpUrl,
    token,
    '/api/cron/delivery-targets',
  );
}
