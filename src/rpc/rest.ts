/**
 * Hermes serve 的 REST 端点（WS JSON-RPC 之外的 HTTP 接口）。
 * 认证：header `X-Hermes-Session-Token`；/api/files/download 另允许 ?token= 查询参数
 * （web_server.py `_QUERY_TOKEN_API_PATHS`——RN <Image> 不便设 header 时用查询参数兜底，
 * 与 desktop 的 mediaExternalUrl 同款做法）。
 *
 * 注意：图片必须走 /api/files/download——/api/files/stream 是 media_only，
 * 只放行音视频扩展名（.m4a/.mp3/.mp4/…），图片会 415。
 */

export interface TranscribeResult {
  ok: boolean;
  /** 识别文本（未检测到语音时为空串，不是错误） */
  transcript: string;
  provider?: string | null;
}

/**
 * REST 请求超时，与 WS RPC 层（rpc/client.ts 的 requestTimeoutMs=30s）对齐。
 * RN 的 fetch 默认永不超时：SSH 隧道半开（锁屏/切网后静默断开）时请求会无限挂起。
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * POST /api/audio/transcribe：语音转文字。
 * body: {data_url: "data:audio/m4a;base64,...", mime_type}；
 * profile 是 **查询参数**（FastAPI 函数签名形参，不在 body 模型里）。
 * 失败抛 Error（HTTP 状态 + 服务端 detail；超时抛明确文案）。
 */
export async function transcribeAudio(
  httpUrl: string,
  token: string,
  dataUrl: string,
  profile?: string,
  mimeType = 'audio/m4a',
): Promise<TranscribeResult> {
  const qs = profile ? `?profile=${encodeURIComponent(profile)}` : '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(`${httpUrl}/api/audio/transcribe${qs}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? {'X-Hermes-Session-Token': token} : {}),
      },
      body: JSON.stringify({data_url: dataUrl, mime_type: mimeType}),
      signal: controller.signal,
    });
    const body: unknown = await resp.json().catch(() => null);
    if (!resp.ok) {
      const detail = (body as {detail?: unknown} | null)?.detail;
      throw new Error(
        typeof detail === 'string' ? detail : `语音转文字失败（HTTP ${resp.status}）`,
      );
    }
    const result = body as Partial<TranscribeResult> | null;
    return {
      ok: result?.ok !== false,
      transcript: typeof result?.transcript === 'string' ? result.transcript : '',
      provider: result?.provider ?? null,
    };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`语音识别超时（${REQUEST_TIMEOUT_MS / 1000} 秒），请检查连接后重试`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** gateway 侧绝对路径 → 可喂给 <Image> 的下载 URL（query token 认证）。 */
export function fileDownloadUrl(
  httpUrl: string,
  path: string,
  token: string,
): string {
  const q = `path=${encodeURIComponent(path)}`;
  const t = token ? `&token=${encodeURIComponent(token)}` : '';
  return `${httpUrl}/api/files/download?${q}${t}`;
}
