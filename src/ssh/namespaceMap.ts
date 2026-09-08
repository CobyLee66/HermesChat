/**
 * namespaceMap.ts — multiplex（multiplex_profiles）环境下的会话归属映射。
 *
 * 背景（已实测核实）：启用 multiplex 后，qqbot 等网关会话物理上全部写在
 * 宿主 profile（本机为 main）的 state.db，`sessions.session_key` 形如
 * `agent:<profile名>:qqbot:dm:<hash>`，第二段是归属命名空间。官方
 * `session.list` 只投影 {id,title,preview,started_at,message_count,source}，
 * 不含 session_key，因此通过 SSH exec 对各 state.db 做**只读** sqlite3
 * 查询，一次性构建 sessionId → 归属 映射。远端无 sqlite3 / exec 不可用
 * （web 直连）时映射为空，静默降级（行为 = 全部显示在宿主 profile 下）。
 */

import type {ProfileInfo, SessionListRow} from '../rpc/types';
import type {ExecRemoteFn} from './execRemote';

export interface NamespaceEntry {
  /** 归属命名空间（session_key 第二段，通常等于 profile 名） */
  namespace: string;
  /** 物理宿主 profile（该行所在 state.db 对应的 profile） */
  host: string;
}

export interface NamespaceMap {
  /** sessionId → 归属（仅含 session_key 为 agent:* 的行） */
  byId: Record<string, NamespaceEntry>;
  /**
   * sessionId → 行活跃时间（last_activity_at 与最新消息时间的较新者，
   * 兜底 started_at；同款口径见服务端 hermes_state_common 的
   * _sql_session_last_active）。所有行都带，跨库交错排序用。
   */
  lastActiveById: Record<string, number>;
}

export const EMPTY_NAMESPACE_MAP: NamespaceMap = {byId: {}, lastActiveById: {}};

/** session_key `agent:<ns>:...` → ns；非 agent 前缀/形状不符 → null。 */
export function parseNamespace(
  sessionKey: string | null | undefined,
): string | null {
  if (!sessionKey || !sessionKey.startsWith('agent:')) {
    return null;
  }
  const rest = sessionKey.slice('agent:'.length);
  const idx = rest.indexOf(':');
  if (idx <= 0) {
    return null;
  }
  return rest.slice(0, idx);
}

/** shell 单引号转义（路径里含单引号时安全）。 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * 收集候选库路径：每个 profile 的 <path>/state.db，外加 hermes 根
 * （profiles/<name> 的上两级）的 state.db 兜底。返回去重后的 db 路径
 * 列表（保持顺序）与 dbPath → profile 名 的归属表。
 */
export function collectDbPaths(profiles: ProfileInfo[]): {
  dbPaths: string[];
  dbToProfile: Record<string, string>;
} {
  const dbPaths: string[] = [];
  const dbToProfile: Record<string, string> = {};
  let hermesRoot: string | null = null;
  const add = (db: string, name: string) => {
    if (!(db in dbToProfile)) {
      dbPaths.push(db);
      dbToProfile[db] = name;
    }
  };
  for (const p of profiles) {
    const norm = (p.path ?? '').replace(/\/+$/, '');
    if (!norm) {
      continue;
    }
    add(`${norm}/state.db`, p.name);
    const m = norm.match(/^(.*)\/profiles\/[^/]+$/);
    if (m && !hermesRoot) {
      hermesRoot = m[1];
    }
  }
  if (hermesRoot) {
    // hermes 根库通常就是 is_default profile 的 path（会被上面去重）；
    // 找不到对应 profile 时归到 default（仅影响 host 标记，不影响映射内容）
    const def = profiles.find(p => p.is_default)?.name ?? 'default';
    add(`${hermesRoot}/state.db`, def);
  }
  return {dbPaths, dbToProfile};
}

/**
 * 只读扫描命令（单条 exec 完成）：逐库输出 `#DB <path>` 标记行 +
 * `<id>\t<session_key>\t<活跃时间>` 数据行。全表（不过滤 agent:%），
 * 会话排序要用每行的活跃时间；归属映射仍只认 agent: 前缀（解析侧过滤）。
 * 某库不存在/sqlite3 缺失时静默跳过（2>/dev/null），整体降级为部分/空映射。
 */
export function buildScanCommand(dbPaths: string[]): string {
  const list = dbPaths.map(shQuote).join(' ');
  // 活跃时间 = MAX(last_activity_at 心跳, 最新消息时间)，兜底 started_at
  // —— 与服务端 _sql_session_last_active 同口径（消息时间可能新于限流的
  // 心跳，不能只用 last_activity_at）。messages(session_id,timestamp) 有索引。
  const activityExpr =
    "COALESCE((SELECT MAX(v) FROM (SELECT s.last_activity_at AS v " +
    'UNION ALL SELECT (SELECT MAX(m.timestamp) FROM messages m ' +
    'WHERE m.session_id = s.id) AS v) v), s.started_at, 0)';
  return [
    `for db in ${list}; do`,
    `  [ -f "$db" ] || continue`,
    `  echo "#DB $db"`,
    `  sqlite3 "file:$db?mode=ro" "SELECT id || char(9) || COALESCE(session_key,'') || char(9) || ${activityExpr} FROM sessions s" 2>/dev/null`,
    `done`,
  ].join('\n');
}

/**
 * 解析扫描输出 → 映射。归属表（byId）：agent: 前缀行且宿主在已知 profile
 * 表里；活跃表（lastActiveById）：所有可解析为数字的行（含未知宿主——
 * 排序只需要 id → 时间，宿主无关）。
 */
export function parseScanOutput(
  stdout: string,
  dbToProfile: Record<string, string>,
): NamespaceMap {
  const byId: Record<string, NamespaceEntry> = {};
  const lastActiveById: Record<string, number> = {};
  let host = '';
  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    if (line.startsWith('#DB ')) {
      host = dbToProfile[line.slice(4).trim()] ?? '';
      continue;
    }
    const tab = line.indexOf('\t');
    if (tab <= 0) {
      continue;
    }
    const id = line.slice(0, tab).trim();
    if (!id) {
      continue;
    }
    const rest = line.slice(tab + 1);
    const tab2 = rest.indexOf('\t');
    const key = (tab2 >= 0 ? rest.slice(0, tab2) : rest).trim();
    const ns = parseNamespace(key);
    if (ns && host) {
      byId[id] = {namespace: ns, host};
    }
    if (tab2 >= 0) {
      const ts = Number(rest.slice(tab2 + 1).trim());
      if (Number.isFinite(ts) && ts > 0) {
        lastActiveById[id] = ts;
      }
    }
  }
  return {byId, lastActiveById};
}

/** 经 SSH exec 一次性构建映射；任何失败都返回空映射（静默降级）。 */
export async function fetchNamespaceMap(
  exec: ExecRemoteFn,
  profiles: ProfileInfo[],
): Promise<NamespaceMap> {
  const {dbPaths, dbToProfile} = collectDbPaths(profiles);
  if (dbPaths.length === 0) {
    return EMPTY_NAMESPACE_MAP;
  }
  try {
    const res = await exec(buildScanCommand(dbPaths), 30000);
    return parseScanOutput(res.stdout, dbToProfile);
  } catch {
    return EMPTY_NAMESPACE_MAP;
  }
}

/** 映射里 namespace === ns 且宿主 ≠ self 的宿主 profile 列表（去重）。 */
export function foreignHostsOf(
  map: NamespaceMap,
  ns: string,
  self: string,
): string[] {
  const out = new Set<string>();
  for (const e of Object.values(map.byId)) {
    if (e.namespace === ns && e.host !== self) {
      out.add(e.host);
    }
  }
  return [...out];
}

/**
 * 分组投影：own 列表 + foreign 列表（已标记 namespaced/hostProfile）合并。
 * - own 中命名空间属于其他现存 profile 的行排除（移到该 profile 下显示）；
 * - 无映射（App 创建/fork 的会话）、namespace == 本 profile、namespace 不
 *   属于任何现存 profile（已删除的 profile 等）的行保留；
 * - 按 id 去重（own 优先）。
 *
 * 排序（会话列表「最近消息」档的口径）：`session.list` 服务端已按
 * last_active 降序返回（order_by_last_active 写死，压缩链感知），但投影
 * 不含该值——单库行（无 foreign）直接保持服务端返回序，最准；有 foreign
 * 时两个库各自有序但无法互比，用扫描所得的活跃时间（lastActiveById，
 * 缺失回退 started_at）交错排序。稳定排序保证同键时 own 在前。
 */
export function projectProfileSessions(opts: {
  own: SessionListRow[];
  foreign: SessionListRow[];
  map: NamespaceMap;
  profile: string;
  knownProfiles: ReadonlySet<string>;
}): SessionListRow[] {
  const seen = new Set<string>();
  const out: SessionListRow[] = [];
  for (const r of opts.own) {
    const e = opts.map.byId[r.id];
    if (
      e &&
      e.namespace !== opts.profile &&
      opts.knownProfiles.has(e.namespace)
    ) {
      continue;
    }
    if (!seen.has(r.id)) {
      seen.add(r.id);
      out.push(r);
    }
  }
  for (const r of opts.foreign) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      out.push(r);
    }
  }
  // 扫描出的活跃时间挂到行上（列表行时间展示 / 跨库排序共用）
  const withActivity = out.map(r => {
    const la = opts.map.lastActiveById[r.id];
    return la && la !== r.started_at ? {...r, last_active: la} : r;
  });
  if (opts.foreign.length === 0) {
    return withActivity;
  }
  const activeOf = (r: SessionListRow) =>
    (opts.map.lastActiveById[r.id] ?? r.started_at ?? 0) as number;
  withActivity.sort((a, b) => activeOf(b) - activeOf(a));
  return withActivity;
}
