# Hermes serve 协议速查（App 开发用）

> 来源：本机 Hermes Agent v0.21.0 源码 + 实测。源码 ground truth（不确定时直接查）：
> - `~/.hermes/hermes-agent/hermes_cli/web_server.py`（WS 握手、REST 路由）
> - `~/.hermes/hermes-agent/tui_gateway/server.py` + `methods_*.py`（RPC 方法，搜 `@method`）
> - `~/.hermes/hermes-agent/tui_gateway/ws.py`（WS 循环、事件推送）
> - `~/.hermes/hermes-agent/apps/shared/src/json-rpc-gateway.ts`（事件名权威清单 `GatewayEventName`）
> - `~/.hermes/hermes-agent/web/src/lib/gatewayClient.ts`（web dashboard 客户端参考实现）

## 1. 连接与认证

- 服务：`hermes dashboard` / `hermes serve`（FastAPI+uvicorn），默认 `127.0.0.1:9119`。就绪时 stdout 打印 `HERMES_DASHBOARD_READY port=<n>`（serve 模式为 `HERMES_BACKEND_READY port=<n>`）。
- WS 端点：`GET /api/ws`。线协议：每个 WS text 帧 = 一条 JSON-RPC 2.0。
  - 请求：`{"jsonrpc":"2.0","id":<int>,"method":"...","params":{...}}`
  - 响应：`{"jsonrpc":"2.0","id":<int>,"result":...}` 或 `{"error":{"code":<自定义码>,"message":...}}`
  - 事件：`{"jsonrpc":"2.0","method":"event","params":{"type":"<事件名>","session_id":"<sid可选>","payload":{...}}}`
  - 全局广播事件无 session_id（如 `sessions.changed`、`skin.changed`）。
- 认证（loopback 模式）：`ws://127.0.0.1:9119/api/ws?token=<SESSION_TOKEN>`；REST 用 header `X-Hermes-Session-Token: <token>`。
- token 获取（优先级）：`HERMES_DASHBOARD_SESSION_TOKEN` 环境变量（启动时注入）> `--ssh-session-token-file <path>` > 随机生成（注入 SPA HTML：`GET /` → 正则 `__HERMES_SESSION_TOKEN__="([^"]+)"`，已实测可用）。App 侧「直连」配置类型（2026-09-08）用同一提取机制：`GET http://<host>:<port>/` 抓 SPA HTML（浏览器/桌面渲染层因跨源限制需经 vite dev proxy / 主进程代取），token 也可在配置中手动填写兜底。
- 直连模式注意：web_server 有 Host/Origin 校验（DNS-rebinding 防护）——渲染层经代理时须重写 Host/Origin 为上游地址（vite.config.ts 与 desktop/main.ts 同策略）；Android 原生 WS/fetch 不受 CORS 限制可直连任意 host:port，但 gateway 默认只监听 127.0.0.1，局域网设备直连需 `hermes serve --host 0.0.0.0`。
- 连接建立后服务端立即推事件 `gateway.ready`，payload `{"skin": {...}, "change_events": true}`。
- 公开 REST（无需认证）：`/api/health`、`/api/status`、`/api/config/defaults`。
- 断线恢复：服务端对孤儿会话有 ~20s 宽限（`HERMES_TUI_WS_ORPHAN_REAP_GRACE_S`），WS 重连后 `session.resume` 可重挂 inflight turn。服务端回收会话时广播 `session.reclaimed`。
- 自定义错误码（非标准 JSON-RPC）：4006=缺参数、4007=session not found、4009=session busy、4023=不能删活动会话、4090=活动会话数超限、4130=resume 的 transcript 过大 等。

### 实测确认记录（2026-09-01，harness 对本机 live dashboard）
- 全流程已跑通：token 提取 → WS → gateway.ready → profiles.list → session.list{profile:"main"} → session.create → prompt.submit → 事件流 → message.complete → session.close（`{"closed":true}`）。
- `session.title` 事件在首轮后推送（服务端自动命名）。
- `model.options` 当前 provider slug 为 `custom:deepseek`（小写），与 profiles.list 的 `custom:DeepSeek` 大小写不一致——比较时归一化。
- harness 脚本：`scripts/harness.mjs`（全流程仅一次真实 prompt.submit）。

## 2. RPC 方法（App 需要的子集）

### 会话
- `session.create` params `{cols, cwd?, profile?, model?, provider?, reasoning_effort?, fast?, title?, parent_session_id?, messages?, source?, close_on_disconnect?}` → `{session_id, stored_session_id, message_count, messages, info}`。`cols` 传 80~120 即可。**实测确认**（harness）：`session_id` 是 8 位 live id（事件流里的 `session_id`），`stored_session_id` 是持久化 id（`session.list`/`session.resume` 用它）；`info` 含 `{model, provider?, tools, skills, cwd, branch, project, lazy, desktop_contract, profile_name}`（**无 usage 字段**）。
- `prompt.submit` params `{session_id, text}` → `{"status":"streaming"}`；真正的回复走事件流。**已实测**。
- `session.interrupt` params `{session_id}` → `{"status":"interrupted"}`（中断当前 turn）。
- `session.list` params `{limit?, profile?}` → `{sessions:[{id,title,preview,started_at,message_count,source}]}`。**已实测**（字段一致）。
  - **返回顺序即「最近活跃」降序**（2026-09-08 查源码确认：methods_session.py 写死 `list_sessions_rich(order_by_last_active=True)`）：按 effective last_active 排（压缩链取 tip 活跃时间，`_effective_last_active`），但**投影不含 last_active 值**——客户端拿到的是「有序无值」的列表。会话列表「最近消息」排序档（D033）因此直接保持此顺序； multiplex 跨库合并时由 namespaceMap exec 扫描补齐每行活跃时间（`MAX(last_activity_at, MAX(messages.timestamp))` 兜底 started_at，同 hermes_state_common `_sql_session_last_active` 口径）做交错。REST `/api/sessions` 行虽带 `last_active` 且支持 `order=recent|created`，但行序与 WS 同源、App 无需为此引入 REST 依赖。
  - **`source` 取值与分类**（2026-09-05 查 dashboard 源码 + 实测 state.db）：写入端打的平台标签，本机实测有 `tui/cli/cron/qqbot/subagent`（qqbot 是 QQ 机器人的会话来源，与 multiplex 的 namespace 是两回事）。dashboard（`web/src/pages/SessionsPage.tsx` 的 `AUTOMATION_SESSION_SOURCES`）把 `cron/tool/api_server/acp/hermes_flow/vulcan_delegate/webhook` 归为**自动化**会话，其余（tui/cli/telegram/discord/qqbot/subagent…）归为普通聊天；三档过滤 chats/automation/all，默认 chats。App 侧同口径实现见 `src/utils/sessionSources.ts`。
  - **App 自建会话的 source**：`session.create` 不传 source 时由 tui_gateway `_resolve_session_platform()` 兜底——`HERMES_DESKTOP=1` → `desktop`，否则 `tui`，都落在「聊天」类，不会被自动化档误滤。WS `session.list` 无 source 过滤参数（REST `/api/sessions` 才有 `sources`/`exclude_sources`），客户端过滤是唯一选择。
- `session.resume` params `{session_id, profile?, cols?, omit_messages?}` → 重挂会话（含历史消息，除非 omit_messages）。错误码：4007=session not found、4130=transcript 过大（`sessions.max_resume_messages`）。
  - **快路径**（2026-09-05 查 methods_session.py:455 确认）：目标会话仍 live 时**复用并返回同一 live sid**（不新建 agent），同时 re-bind transport、取消孤儿回收计时。→ 客户端重进会话必须**每次都用返回的 messages 重建时间线**（快路径同 sid 时本地旧快照不会自己刷新，App 曾因此「重进停留在旧状态」）。
  - **turn 进行中的恢复字段**：结果带 `running`（turn 进行中）与 `inflight {user, assistant, streaming, error?, corrections?}`（`_inflight_snapshot`：本轮 prompt + 已流出的助手部分文本，**纯文本投影**——不含思考块/工具卡）。mid-turn 重挂正确姿势：hydrate(messages) + 按 inflight 重建流式尾部（prompt 去重），后续 delta 继续追加；本地若已有同 turn 流式尾部（服务端文本是其前缀扩展）优先保留本地结构块（桌面端 preserveStructuralParts 同款取舍）。`running=true` 但 `inflight` 为空（prompt 排队/工具阶段）也建空流式尾部，否则 busy 会在下一次事件快照时闪断。
  - **App 侧补齐纯文本投影的结构丢失**（2026-09-08，D031）：App 重启后重进 mid-turn 会话，本地结构块已没了，inflight 尾部只有文本（工具卡/推理块"丢失"的根因）。修复：这种尾部打 `fromInflightProjection` 标记，`message.complete` 时（turn 结果已先写回 history/落盘，再 emit complete——server.py 顺序保证）用 `session.history`（live sid）重拉并整体 hydrate，工具卡/推理块全恢复。不走 `session.events.since` 重放整轮：replay 环每会话仅 512 帧、message.delta 逐帧计数，长 turn 必 truncated。
- `session.history` params `{session_id}` → `{count, messages}`。⚠️ **只认 live sid**（`_sess_nowait` 直查内存 `_sessions`，key 是 8 位 live id）：对 session.list 返回的持久化 id 一律 4001（已实测，见 §5）。
- `session.usage` params `{session_id}` → **顶层 usage dict**（不是 `{usage:…}`——事件 payload 才包 usage 键；与 session.info/message.complete 的 usage 同构同源，`_get_usage(agent)` 单一计算点，2026-09-09 源码确认 methods_session.py:1825）。**只认 live sid**（`_sess_nowait`，持久化 id 一律 4001）→ 必须在 resume 拿到 live sid 之后调。agent 未建且无快照时返回 `{calls:0, input:0, output:0, total:0}` 零计数（**无 model、无 context_\***，落地后顶栏用量段自然不显示，属服务端口径）；返回可能附 `credits_lines`（Nous 门户积分行，TUI /usage 面板用），客户端忽略。用途：重进会话主动同步顶栏「模型/上下文用量」——resume 返回的 info 普遍缺 usage，不读回则要等新消息输出的事件才刷新（App 实现：chat store `syncSessionInfo`）。
- `session.delete` params `{session_id, profile?}`；`session.close` params `{session_id}` → `{"closed":true}`（删除活动会话报 4023，先 close）。**已实测/源码确认（2026-09-08）**：
  - **两者认的 id 不同**：`session.close` 直查网关内存 `_sessions`，**只认 live sid**（传持久化 id 静默 `closed:false` 不报错）；`session.delete` 的活动判定（4023）与查库都用**持久化 id**（传 live sid 一律 4007）。删除当前打开（活动）的会话必须 `close(live sid)` → `delete(持久化 id)` 配合。
  - App 侧 `sessions store remove()` 已按此归一化（接受任一 id，内部经 chat store 反查），列表长按/右键删活动会话的存量 4023 死循环也一并修掉。
  - **`profile` 参数决定在哪个库删**（2026-09-08 源码+实测）：`_profile_home(params.profile)` 选中该 profile 自己的 state.db 后 `WHERE id = ?` 精确匹配（`hermes_state.py delete_session`），无行即 4007。multiplex 下 namespaced 行物理在宿主库，**必须传宿主 profile**（本机为 main）——传名义 profile（如 finance）必 4007，且客户端删除失败时列表不过滤 → 「报 session not found 但行仍可见、重试恒失败」（某 profile profile 8/30 未命名会话 bug 根因）。App 侧 `remove()` 按行的 `namespaced/hostProfile` 标记路由到宿主库；实测 `20260830_195341_abcdef01`（finance 命名空间、物理在 main 库、finance 库无此行）传 `profile:"main"` 一次删除成功。
- `session.title`（改名）params `{session_id, title?}`：**不带 `title` 即只读形式**（已从源码确认，methods_session.py:1425）→ `{title, session_key}`，返回库中 sanitize 后的值；会话行尚未落库时先把 `pending_title` 落库再返回（`_ensure_session_db_row`）。带 `title` 则改名 → `{pending, title}`。
  - ⚠️ **手动 `/title` 斜杠命令不走这个 RPC**：`slash.exec` 把 title 交给 slash worker 子进程（CLI 的 `/title` 处理，`cli.py`）直接写 state.db，**服务端既不推 `session.title` 也不推 `session.info` 事件**（`_mirror_slash_side_effects` 无 title 分支），跨进程唯一信号是 `sessions.changed`（state.db mtime 签名，0.5s 检查 + 2s 合并窗口，见 server.py `_CHANGE_WATCHES`）。→ 客户端要「改完立即刷新」只能命令执行后主动读回本 RPC 只读形式（App 实现：chat store `refreshTitle`，`/title` 命令后调用）。
  - `session.title` **事件**（首轮自动命名时推送，`agent._on_session_title` 钩子）payload `{session_id, title}`——注意 payload 里的 `session_id` 是**持久化 id**（`session_key`），事件帧外层的 `session_id` 才是 live sid（客户端按外层 key 归位，用 payload 的 id 回填列表行）。
  - `session.info` 事件的 payload 也带 `title`（`_session_info` 里 `_session_live_title`）——改名 RPC/压缩/切模型等广播时同样可作标题回填来源。
- `session.status`（返回 `{output}` 纯文本状态块）。
- ⚠️ **`session.info` 不是 RPC 方法**（tui_gateway 里无对应 `@method`），只是事件 + create/resume 结果里的 `info` 字段。会话信息弹层用缓存的 info 即可，不要 RPC 调用它。
- 会话"重开"：无专门 reset RPC。**已查源码确认方案 A 不可行**：`/reset` 是 `/new` 的别名（`hermes_cli/commands.py`，`gateway_only=True`），`slash.exec` 会把它路由到 slash worker 子进程里一个全新的 HermesCLI 实例执行，对 gateway 里的目标会话**没有影响**。→ 用方案 B：`session.create` 新会话（App 已按此实现，见 ChatScreen 注释）。
- `slash.exec` params `{session_id, command}`（**已从源码确认**，methods_tools.py:1108；command **去掉前导 `/`**）→ `{output, warning?}`；命中 `_PENDING_INPUT_COMMANDS`（retry/queue/steer/goal/loop/undo/compress…）与 skill bundle 时服务端内部转 `command.dispatch`。**prompt.submit 不拦截斜杠文本**（methods_prompt.py 无任何 slash 逻辑）——客户端发送 `/` 开头文本前必须自行分流，否则命令被当普通消息直达模型。App 执行流水线在 `src/rpc/slash.ts`（移植 dashboard 官方预留给第三方客户端的 `web/src/lib/slashExec.ts` 契约）：先 `slash.exec`，失败（拒绝/未知/skill 命令 err 4018）回退 `command.dispatch`，其中 `type:"skill"|"send"` 取 `message` 再转 `prompt.submit`、`type:"alias"` 用 `target` 递归、`exec/plugin` 直接展示 `output`。
- `complete.slash` params `{text}`（**光标前全文，须以 `/` 开头**；只读 RPC，2026-09-06 已实测）→ `{items: [{text, display, meta, kind: "command"|"skill"}], replace_from: number}`。匹配/排序/截断全在服务端（`tui_gateway/methods_complete.py`，dashboard 三端同源）：名称阶段（无空格）`replace_from=1`，registry 项 `text` 不带 `/` 而 TUI extras（/density 等）带 `/`，拼接时前一位已是 `/` 须去项首斜杠防 `//`；参数阶段（含空格）`replace_from=text.rfind(" ")+1`，返回子命令/参数项（实测 `/cron ad`→`add`、`/reasoning `→none/minimal/…，`/details` 多级带说明），命令项 `meta` 自带 `(usage: /model [model] ...)` 参数说明。⚠️ `/model` 是交互式选择非文本参数：TUI 特判不进补全、提交开两步模型选择器（App 同款：输入 `/model…` 不弹补全，裸 `/model` 回车开 ModelPicker，带参数走执行流水线）。
- `command.dispatch` params `{name, arg, session_id}`（name 不带 `/`）→ 类型化指令 `{type:"exec"|"plugin", output?}` | `{type:"alias", target}` | `{type:"skill", name, message?}` | `{type:"send", message}`；未知 type/缺字段视为错误。另有 `commands.catalog`（全量命令目录：pairs/categories/subcommands/commands(含 argument_mode)/skills 用量），dashboard desktop 端做分组与参数模式用，App 未使用。

### profile / 模型 / 配置
- `profiles.list` → `{profiles: [{name, path, is_default, model, provider, description, skill_count, last_session, ui_meta?, has_avatar}]}`。**已实测**：返回外层确有 `profiles` 键（保留 `result.profiles ?? result` 兼容即可）；`last_session` 含 `{id,title,preview,started_at,last_active,message_count}` 或 null；本机 profile 均未设 `ui_meta`（昵称兜底顺序：ui_meta.nickname → description → name）。
- `profiles.get_asset` **已落实**（methods_profiles.py:866 + 实测）：params `{name, asset?="avatar"}` → `{found, mime?, size?, data?}`，`data` 是 `data:<mime>;base64,...` 可直接喂 `<Image source={{uri}}>`；无头像返回 `{found:false}`（**不是错误**，实测 main 即如此）→ 昵称首字符色块兜底。
- `profiles.configure` **已从源码确认**（methods_profiles.py:577）：params `{name, ...}`，其中 `ui_meta` 为 dict 时**键级合并**进 profile.yaml 的 ui_meta 块——值为 `null` 删除该键；整体 JSON ≤64KB（拒绝大 blob，头像走 set_asset）。昵称 = `profiles.configure {name, ui_meta:{nickname:"..."}}`。结果 `{ok, applied:{ui_meta:true|false,...}}`——分节独立应用，务必检查 `applied.ui_meta`。
- `profiles.set_asset` **已从源码确认**（methods_profiles.py:780）：params `{name, asset:"avatar", data}`（data URL 或裸 base64）→ `{ok, asset, size}`；删除 `{name, asset:"avatar", clear:true}` → `{ok, asset, size:0, removed}`。限制：PNG/JPEG/WebP（**magic-byte 校验**，不信声明的 mime）、解码后 ≤2MB；落盘为 profile 目录下 `assets/avatar.<ext>`（先清其他扩展名，一个 asset 一份文件）。
- `model.options` **已实测落实**：→ `{providers: [{slug, name, is_current, is_user_defined, models: string[], total_models, source, authenticated, auth_type, warning, capabilities, featured_models}], model, provider}`。按 provider 分组渲染 `models` 数组即可；注意 `session.info` 里 provider 是 `custom` 而 profiles/model.options 里可能带大小写不同的 `custom:DeepSeek` 形式。
- 切模型：`config.set` params `{key:"model", value:"<model> [--provider <slug>]", session_id}`（turn 进行中返回 `deferred:true`，defer 到下一 turn；其余字段 `{key,value,warning,confirm_required,confirm_message,scope}`）。读当前：`config.get` params `{key:"model"|"provider"|"full"|..., session_id?}`。

### 审批 / 交互（服务端阻塞等待应答）
- `approval.respond` params `{session_id, request_id?, choice:"once"|"session"|"always"|"deny", all?}` → `{resolved: <处理条数>}`。**已从源码确认**（methods_prompt.py:1881）。`request_id` 省略时按 FIFO 解最老一条；`always` 的持久化 pattern 完全由服务端自带 `pattern_keys` 决定，客户端不传。
- `approval.received` params `{session_id, request_id}` → `{acknowledged}`：UI 展示审批卡时回执（desktop 同款做法）。
- `clarify.respond {request_id, answer, question_id?}`（allow_expired，迟到应答返回 `{status:"expired"}` 不报错）：answer 单选=选项文本、**多选=JSON 字符串数组**（desktop 参考实现如此）、自由文本=原文；批量问题逐题带 `question_id`（qid），全答完才释放（server.py `_batch_clarify`）。`sudo.respond {request_id, password}`、`secret.respond {request_id, value}` 同机制（App 暂未实现 UI）。
- ⚠️ **事件单播**：带 session_id 的事件帧只发给会话**最后绑定的 transport**（`write_json` → `session["transport"]`；create/resume/prompt.submit 都会 re-bind）。同一会话被 dashboard/TUI 打开过后，手机端就收不到审批/澄清事件。兜底：**resume 返回 `pending_approval`/`pending_clarify` 字段**（App 已在 attach/reattachAfterResume 消费恢复卡片），另有 `approval.pending {session_id}` RPC 可主动拉取；事件帧带 per-session `seq`，可用 `session.events.since {session_id, last_seen}` 补漏。
  - ⚠️ **两个 pending 字段都是「单个对象」，不是数组**（源码 `tui_gateway/server.py` `_live_session_payload` → `_pending_approval_request_payload` / `_pending_clarify_request_payload`，返回 `dict | None`；无挂起时**字段直接不存在**）。内容与对应事件的 payload 同形：`pending_approval = {request_id, command, description, choices[], …}`；`pending_clarify` 单问 `{request_id, question, choices?, multi_select?}`、批量 `{request_id, questions:[{qid, question, choices, multi_select}], answers?: {qid: 答案}}`（**answers 只在 resume 快照里回放**服务端已锁定的逐题答案，见 `_batch_clarify`）。
  - ⚠️ **踩坑（2026-09-11 线上故障）**：客户端曾按数组声明这两个字段并直接 `for...of`，于是「clarify 挂起期间打开会话」必抛 TypeError——Android Hermes 的报错文案正是 **`iterator method is not callable`**（`libhermesvm.so` 内建串；V8 是 "… is not iterable"，desktop/web 同样会炸只是文案不同），用户看到的是「打开会话失败」；clarify 超时（用户本机 `clarify_timeout`=3600s）后字段消失，会话又能正常打开。现统一在 `store/chat.ts` 的 `asPendingList()` 归一化（`OneOrMany<T> = T | T[]`，旧版服务端若返回列表形态也兼容）；所有消费点都经 `attach`/`reattachAfterResume`，**新增调用点不要直接迭代 wire 字段**。

### 附件（M3 已实现，全部从源码确认）
- `image.attach_bytes {session_id, content_base64, filename?, ext?}`（methods_prompt.py:823）→ `{attached, path, count, remainder:"", text, bytes, name, width?, height?, token_estimate?}`。远程客户端 base64 上传；`content_base64` 接受裸 base64 或 `data:image/...;base64,` 前缀（可含空白），解码后 ≤25MB（`_ATTACH_BYTES_MAX_BYTES`）。**扩展名优先采信 filename 后缀**，其次 magic bytes（PNG/JPEG/GIF/WebP/BMP）——所以客户端重编码成 JPEG 后必须把文件名改成 .jpg。写入 `<profile_home>/images/upload_<ts>_<n>.<ext>` 并进 session 的 `attached_images` 队列，**随下一条 `prompt.submit` 进上下文**；空文本 prompt 也合法（服务端补 "What do you see in this image?"）。错误码：4001 session not found、4015 缺参数、4016 不支持的扩展名、4017 非 base64/空、4018 超 25MB。
- `image.detach {session_id, path}` → `{detached, count}`：从队列摘除（path 须与 attach 返回的一致）。
- `file.attach {session_id, path?, data_url?, name?}`（methods_prompt.py:1010）→ `{attached, name, path, ref_path, ref_text, uploaded}`。非图片文件落盘到 session workspace 并返回 `@file:` 引用：`ref_text` 形如 `@file:attachments/…`（含空格时值带引号），**追加到输入框文本末尾**随 prompt 一起发，agent 的文件工具可据引用读取。path 与 data_url 二选一；远程客户端用 data_url（`data:<mime>;base64,…`）。
- REST `POST /api/audio/transcribe`（web_server.py:4637）：**请求体 JSON `{data_url, mime_type?}`；`profile` 是查询参数**（FastAPI 函数形参，不在 body 模型里——desktop 客户端同时放 query 和 body，真正生效的是 `?profile=`）。header 认证 `X-Hermes-Session-Token`。响应 `{ok:true, transcript, provider?}`；**未检测到语音不是错误**：返回 `{ok:true, transcript:""}`。失败为 HTTP 错误 + `{detail}`（400 非法 payload/非音频/非 base64/空、413 超 25MB、500 转写失败）。m4a（AAC）可用，mime 须 `audio/*`（或 video/webm）。
  - **客户端行为**（2026-09-05）：App 侧 fetch 带 30s AbortController 超时（`rest.ts`，对齐 WS RPC 层），VoiceButton 再加 35s 整体 Promise.race 兜底——RN fetch 永不超时，SSH 隧道半开时请求无限挂起会把 UI 永久卡在「识别中」。
  - **识别语言完全由服务端决定，接口无 language 参数**（`AudioTranscriptionRequest` 只有 data_url/mime_type）。服务端解析链（transcription_tools.py `_resolve_stt_language`）：`stt.<provider>.language` → `stt.language` → env `HERMES_LOCAL_STT_LANGUAGE` → None=自动检测；但 `local_command` 路径（whisper 二进制）兜底**默认 "en"**。实测（2026-09-05 服务端日志）：faster-whisper `base` 对 ≤7s 的中文录音自动检测**全部误判 `lang=en`** 输出英文；要稳定中文须服务端配置 `stt.local.language: zh`（或换 `small`+ 模型）。App 暂不处理（D020），上游若加 language 参数后客户端再传。
  - **`?profile=` 同时决定 STT 配置作用域**（2026-09-08 排查实锤，D034 修订 D020）：端点内 `_config_profile_scope(profile)` 把 HERMES_HOME 切到**该 profile 的 home** 再 `load_config()`（None/""/"current" = dashboard 自身 profile），语言/模型按「当前会话所属 profile」的 config.yaml 解析——multiplex 下只改 main/default 不够，其余 profile 的语音仍走自动检测误判 en（09-08 21:42 日志 `Transcribed hermes-desktop-voice-*.m4a ... lang=en` 实锤，该文件名前缀即本端点临时文件 `web_server.py:5381`）。`load_config()` 按 (mtime_ns, size) 逐次校验、按路径分键缓存：**改 yaml 即热生效，无需重启**。已把本机 6 个 profile 全量配 `stt.language: zh` + `local.model: small`（经用户授权的服务端配置修改，非代码改动）。
- REST 文件下载（渲染消息里的图片）：`GET /api/files/download?path=<gateway 绝对路径>&token=<SESSION_TOKEN>`（web_server.py:2630）——path 须为**绝对路径**（无 locked_root 时）；这是**唯一允许 `?token=` 查询参数认证**的路由（`_QUERY_TOKEN_API_PATHS`，desktop `mediaExternalUrl` 同款），RN `<Image>` 用它。⚠️ **不要用 `/api/files/stream`**：它 `media_only=True`，只放行音视频扩展名（.avi/.flac/.m4a/.mkv/.mov/.mp3/.mp4/.ogg/.opus/.wav/.webm），图片会 415。download 路由同样接受 header 认证，上限 100MB（`_MANAGED_FILE_MAX_BYTES`）。
- WS 帧上限 384MB（`_DESKTOP_ATTACHMENT_WS_MAX_BYTES`）——理论上限而已，客户端应先压缩再传（App：图片长边 2048 JPEG 80，头像 512×512 JPEG 80）。

## 3. 服务端事件（`params.type` → `params.payload`）

- 会话/生命周期：`gateway.ready`、`session.info`、`session.usage`、`session.reclaimed`、`session.seeded`、`session.title {session_id, title}`（首轮后服务端自动命名时推送，**实测出现**）、全局 `sessions.changed`、全局 `cron.changed`（payload 空 `{}`；dashboard 进程每秒轮询 `~/.hermes/cron/jobs.json` mtime，变化即广播——App 用于定时任务列表自动刷新，见 §7）。
- 消息流：`message.start`（payload 为空）→ `message.delta {text, rendered?}`（流式）→ `message.complete {text, usage, status?, rendered?, partial?, error?, reasoning?, warning?}`；`message.interim {text, already_streamed}`（工具回合间中间文本；`already_streamed=true` 表示文本已通过 delta 流出，客户端应密封当前文本段、后续 delta 开新段）。
- 思考/推理：`thinking.delta {text}`、`reasoning.delta {text}`、`reasoning.available {text}`（**实测其 text 是最终回复而非推理内容**，渲染可忽略）。
  - **thinking.delta 是 busy 指示器改写，不是思考内容**（2026-09-05 查 conversation_loop.py:3250 确认）：每次 API 调用开始发一条 `f"{face} {verb}..."`（如 `(´･_･\`) processing...`，脸/动词随机自 KawaiiSpinner），调用结束/被打断发**空串**清除。客户端应按「最新覆盖 + 空串清除」做状态行（桌面端同款：全部不进 transcript 正文；⏳/⚠/↻/⚙ 开头的 provider 等待说明也走它）。**追加式渲染会永远卡在首条占位且不清除**（App 曾踩坑）。真思考走 reasoning.delta / message.complete.reasoning。**动态效果是客户端动画**（2026-09-08 查 ui-tui appChrome.tsx FaceTicker 确认）：服务端每次调用只发一条静态帧，官方 dashboard 的颜文字/动词轮换由客户端做（15 颜文字 content/faces.ts × 15 动词 content/verbs.ts，每 2500ms 顺序轮换、随机起始）——要动态须客户端自行轮换，勿等服务端推送（App 实现：`src/utils/busyTicker.ts` + `src/components/BusyTicker.tsx`，kawaii 帧由动画接管、⏳/⚠/↻/⚙ 等待说明仍原文透传）。
- 工具：`tool.start {tool_id, name, context, args?, args_text?}` —— 注意 80 字预览字段名是 **`context`**（不是 preview）；`tool.progress {tool_id?, preview?}`、`tool.complete {tool_id, name, args, result?, summary?, duration_s?, result_text?, inline_diff?, todos?}`、`tool.generating`、`tool.output_risk`。tool 卡片按 `tool_id` 合并 start/complete。
  - **inline_diff 的展示口径**（2026-09-05 查 display.py/_on_tool_complete 确认）：值是 render_edit_diff_with_delta 的渲染产物——**内嵌 ANSI SGR 色码**、首行 `┊ review diff`、`a/path → b/path` 箭头行、`@@` hunk 头，按 6 文件/80 行截断（尾部 `… omitted N diff line(s)…`）。客户端渲染前须 stripAnsi；+/- 行按行级红绿着色（App 实现见 `src/rpc/diffText.ts`）。**patch 工具的原始 unified diff 在 result JSON 的 `diff` 字段**（无 ANSI）——inline_diff 缺席时的兜底来源；write_file 新建文件无 diff 时 result 里也没有（桌面端直接隐藏该行）。`summary` 是服务端一行式结果摘要，可直接展示。
- 审批/交互请求：`approval.request {request_id, command(已脱敏), description, pattern_key, pattern_keys?, choices:["once","session","always","deny"], allow_permanent, allow_session?, smart_denied?}`（choices 由服务端按 smart_denied/allow_permanent 补齐）；`clarify.request {request_id, question, choices?, multi_select?}` 或批量 `{request_id, questions:[{qid, question, choices?, multi_select?}]}`；`sudo.request`、`secret.request {prompt, env_var}`。统一三段式：请求事件 → `*.respond` RPC → 超时后服务端发 **`<type>.expire {request_id}`**（App 据此把卡片标记为已超时）。
- 状态/错误：`status.update {kind, text}`（kind 实测除 status/process/compacting/lifecycle/loop 外还有 `warn` 等，按字符串原样展示即可）、`error {message}`、`background.complete`。
- `usage` 实测结构（session.info / message.complete / session.usage 三者同构）：`{model, input, output, reasoning, prompt, completion, total, calls, context_used, context_max, context_percent, compressions, active_subagents}`。注意：
  - **没有 `total_tokens` 别名**；`session.usage` 事件（turn 中每秒增量）payload 为 `{usage}`。
  - usage 计数器是 gateway 进程内运行时状态，**resume 历史会话后从 0 重计**（「一直显示 0」是服务端口径，不是 bug）；`session.create`/冷路径 resume 的 info **无 usage 键**。
  - `context_max`（模型上下文窗口上限）与 `context_used/context_percent` 只在本进程至少跑过一轮后才出现；无独立的上下文上限查询 RPC（`session.context_breakdown` 只认 live sid 且同样依赖跑过 turn）。
  - **重进会话的主动同步**（2026-09-09）：resume 返回的 info 普遍缺 usage（快路径 lazy 无 usage/reasoning_effort，冷路径 0 计数）→ 客户端在 resume 拿到 live sid 后主动调 `session.usage` 只读 RPC 读回（App 实现：chat store `syncSessionInfo`，openSessionFlow 正常/fork 分支与重连恢复 resumeActiveSessions 调用；streaming 中让位——ticker 每秒推最新值）。会话已被 gateway 回收后重进走冷路径重建 agent，usage 从 0 重计、`context_*` 要等本进程跑完一轮才出现——主动读回也拿不到，属服务端口径；deferred agent build（lazy）完成后服务端会主动推 session.info 事件兜底思考等级。
- 子代理事件（`subagent.*`）经 `message.*`/`tool.*` 转发，M0 不需要特殊处理。

## 4. 消息数据结构

- 存储为 OpenAI chat 格式：`{"role":"user|assistant|tool|system","content":<str|parts>,"tool_calls":[...],"timestamp","_row_id","display_kind","reasoning"?...}`。
- 客户端投影：`{role, text, timestamp?, row_id?, display_kind?, display_metadata?, reasoning?}`；工具行 `{role:"tool", name, context(80字预览), args?}`。
- 图片消息 content parts：`[{"type":"text","text":...},{"type":"image_url","image_url":{"url":...}}]`；持久化文本为 `@image:<path>` 指令（渲染端还原）。
- **图片/文件引用的持久化与还原**（已从源码确认，M3 按此实现）：
  - 带图用户消息持久化时，文本部分尾部追加 `@image:<path>` 指令行（每行一张，caption 在前——server.py `_build_persist_message_with_image_refs`；路径含空格时按 `format_reference_value` 加反引号/引号）。
  - 原生视觉 turn 的 content parts 经 `_coerce_message_text` 拍平成 text 时，每个 image part 的 URL（多为 `data:image/…;base64,…`）以**独立行**追加——投影 text 里会同时出现 `@image:` 指令行和内嵌 data URL 行，两者都要还原成图片（desktop 参考：`apps/desktop/src/components/assistant-ui/directive-text.tsx` + `src/lib/embedded-images.ts`；指令正则 `/@(file|folder|url|image|tool|line|terminal|session):(`…`|"…"|'…'|\S+)/`）。
  - `@file:<ref>` 同理（file.attach 写入历史的引用），渲染成文件卡片即可。
  - App 端实现：`src/rpc/references.ts` 的 `parseMessageText`（ aggregator hydrate / message.complete / 本地回显三处接入）。

## 5. multiplex_profiles 下的会话 profile 归属分组（客户端方案，2026-09-02 实现）

**背景（已实测核实）**：用户启用 `multiplex_profiles` 后，qqbot 等网关会话物理上全部写在宿主 profile（本机为 main）的 state.db；`sessions.session_key` 形如 `agent:<profile名>:qqbot:dm:<hash>`，第二段是归属命名空间。本机实测分布：main 库 340 行中含 main/finance/study/work/mental-health 五个命名空间 + 269 行无 agent 前缀（App/fork 创建）。

**官方 RPC 的硬限制（不可改，均已实测/源码确认）**：
- `session.list {profile:X}` 只查 X 自己的库，投影 6 列，**不含 session_key** → RPC 层无法分辨归属。
- `session.resume {session_id, profile:X}` 按 X 的库找行：物理在 main 库的会话用 profile=X 报 4007；profile=main 能读但 attach 出 main 人格的 agent（错人格）。
- ⚠️ `session.history {session_id}` **只认 8 位 live sid**（`_sess_nowait` 直查 `_sessions` 内存字典，methods_session.py:2486 + server.py:2459）：对 session.list 返回的持久化 id 一律 **4001**（2026-09-02 实测 finance 命名空间会话，profile=main/finance 均 4001）。它**不能**用来读存储会话的历史。
- `session.create {profile, parent_session_id, messages}`：官方分支链接语义；`_coerce_seed_history`（server.py:7463）接受 `[{role:"user"|"assistant"|"system", content或text: string}]`，丢弃空文本行。

**客户端方案**（纯客户端，不改服务端）：
1. **归属映射**（`src/ssh/namespaceMap.ts`）：SSH exec 一次只读扫描——逐 profile 库 + hermes 根库跑 `sqlite3 'file:<db>?mode=ro' "SELECT id || char(9) || session_key FROM sessions WHERE session_key LIKE 'agent:%'"`，`#DB` 标记行归属宿主，解析出 `sessionId → {namespace, host}`。远端无 sqlite3/exec 不可用（web 直连）→ 空映射静默降级（行为 = 现状）。库路径取自 profiles.list 的 `path`（本机实测：default → `~/.hermes`，main 等 → `~/.hermes/profiles/<name>`）。
2. **列表分组**（`src/store/sessions.ts` refresh）：非宿主 profile = own + 从宿主列表过滤出 namespace==本 profile 的行（标记 `namespaced/hostProfile`），按 id 去重；排序保持服务端最近活跃序，跨库合并（有 foreign 行）时按扫描活跃时间交错（D033，`projectProfileSessions`）；宿主 profile = own 排除 namespace 属于其他现存 profile 的行。连接后拉一次，`sessions.changed`/手动刷新重建。
3. **打开 foreign 会话**（`SessionListScreen.openSession`）：**不 resume**（避免错人格 agent），经 SSH exec 只读 sqlite 直读 messages 表投影历史（`src/ssh/remoteHistory.ts`，hex 传输 content，跳过 tool/hidden/compaction 行，上限 800 行）。聊天页顶部常驻浅灰提示条"QQ 来源会话 · 发送消息将派生到当前 profile 继续"。
4. **首次发送派生**（chat store `forkForeignAndSend`）：只读历史 → `session.create {profile:X, parent_session_id: 原id, messages: 种子}` → attach 切到派生会话（旧 key 标 `migratedTo`，ChatScreen 换路由）→ `prompt.submit` 发这条。AsyncStorage 记 forkMap（`hermes.forkMap.v1`：原id → {forkId, profile}），之后打开直接 resume fork（正常 own 会话）。fork 失败在时间线出错误条。

## 6. 本机联调环境

- 本机已有一个 live dashboard：`127.0.0.1:9119`（`hermes dashboard --open-profile main`，qqbot 已连接，**是用户的真实环境，测试动作要克制**）。
- token：见上文 SPA 提取（当前实测值可复用，但 dashboard 重启会变，脚本应每次重新提取）。
- 实测 profile 列表：default、main(示例 agent，主助手)、finance(理财顾问)、mental-health(心理管家)、study(学习助手)、work(工作助理)。
- **纪律**：harness 全流程只允许一次真实 `prompt.submit`（用最小提示如"回复 pong 两个字即可"），用完 `session.close` 清理；其余测试用 jest mock。

## 7. Cron 定时任务（2026-09-10 源码确认 + 实测，App 已实现）

**通道选型（D038）**：App 走 dashboard REST `/api/cron/*`（9119，与 `/api/ws` 同进程；鉴权复用 `X-Hermes-Session-Token`）+ WS 事件 `cron.changed` 自动刷新。**不用** gateway 平台适配器的 `/api/jobs`（独立 aiohttp 端口 8642，`Authorization: Bearer <API_SERVER_KEY>` 第二凭据；PATCH 白名单只有 name/schedule/prompt/deliver/skills/skill/repeat/enabled）；WS RPC `cron.manage`（tui_gateway/methods_tools.py:1752，action: list/add/remove/pause/resume）**无 update/trigger/runs**，只作对照参考。

### REST 端点清单（web_routers/cron.py；除 fire 外均 header 认证）

全部端点支持 `?profile=` 查询参数（定位/聚合到指定 profile 的 cron 存储）；list 缺省 `profile=all` 跨 profile 聚合（job 行附加 `profile`/`profile_name`/`hermes_home`/`is_default_profile`）。返回 job 的端点在 job 不存在时 404 + `{detail}`。

| 方法 路径 | 请求 | 返回 | 备注 |
|---|---|---|---|
| GET `/api/cron/jobs?profile=all` | — | `CronJob[]`（裸数组） | 原始存储记录 + dashboard 附加字段 |
| GET `/api/cron/jobs/{id}` | — | `CronJob` | id 也可传 name（resolve） |
| GET `/api/cron/jobs/{id}/runs?limit=20` | — | `{runs: SessionInfo[], limit}` | 该 job 产生的 `source=cron` 会话（id 形如 `cron_{job_id}_{ts}`），最新在前；limit 钳制 1..100 |
| POST `/api/cron/jobs` | `CronJobCreate` | `CronJob` | 外部调度器注册失败 → 424 结构化 envelope |
| PUT `/api/cron/jobs/{id}` | `{updates: {...}}` | `CronJob` | 任意字段 dict，服务端归一化；`id` 不可变；terminal（completed/error）不能经 update 重新激活 |
| POST `/api/cron/jobs/{id}/pause` / `resume` | — | `CronJob` | 启停语义 = pause/resume（不是直接改 enabled） |
| POST `/api/cron/jobs/{id}/trigger` | — | `CronJob` | **同步跑完整个 job 才返回**（desktop 客户端给 24h 超时；App 放宽 10 分钟）；已在运行/被其它调度器 CAS 抢占 → 409；one-shot 跑完自删时返回合成记录 `{...job, enabled:false, state:"completed"}` |
| DELETE `/api/cron/jobs/{id}` | — | `{ok: true}` | |
| GET `/api/cron/delivery-targets` | — | `{targets: [{id, name, home_target_set, home_env_var}]}` | 始终含 `local`；`home_target_set=false` 的平台前端提示未配置 home 渠道 |
| GET `/api/cron/blueprints`、POST `/api/cron/blueprints/instantiate` | — | 模板目录/实例化 | App 未接入 |
| POST `/api/cron/fire` | `{job_id}` | 200/503(+`Retry-After: 60`) | 公开路径 + NAS JWT（webhook 专用），App 不涉及 |

**CronJobCreate**（POST body）：`prompt:str`、`schedule:str`（必填）、`name:str=""`（空则自动取 prompt 前 50 字符）、`deliver:str="local"`、`skills?:string[]`、`model?/provider?/base_url?`、`script?`、`context_from?: str|list`（保留项 `"self"` = continuity）、`enabled_toolsets?`、`workdir?`、`no_agent:bool=false`。**CronJobUpdate**：可选字段传 `null` 显式清空（避免残留旧值）——App 表单遵循此语义。

### CronJob 记录关键字段（cron/jobs.py create_job / effective_job_state）

- `id`（12 位 hex，不可变）、`name`、`prompt`（完整）、`skills/skill`、`model/provider/base_url`、`script`、`no_agent`（true=只跑 script）
- `schedule: {kind: "once"|"interval"|"cron", run_at?|minutes?|expr?, display}` + `schedule_display`；schedule 字符串语法（`parse_schedule`，cron/jobs.py:962）：`"30m"/"2h"/"1d"`、`"every 30m"`、`"in 30m"`（一次性）、自然语言（`"daily at 9am"`/`"every monday 9am"`/`"weekdays at 9am"`）、5/6 字段 cron 表达式（需 croniter）、ISO 时间戳（naive 按配置时区锚定，**无 per-job timezone**）
- `repeat: {times: int|null, completed}`（null=forever；one-shot 自动 times=1）
- `enabled` + `state`（读侧派生：`scheduled`/`paused`/`completed`/`error`；`running` 瞬态不落盘；enabled=true 永不显示 paused，terminal 优先）
- `next_run_at` / `last_run_at`（ISO datetime）/ `last_status`（封闭集 `ok`/`error`/`delivery_failed`/`blocked_config`，null=从未跑过）/ `last_error` / `last_delivery_error`（delivery_failed 时 last_error=null）/ `last_fire_error: {at, detail}`（定时 fire 未转发到 gateway）/ `failure_streak`
- `deliver`：`local`/`origin`/`all`/`bot-chat[:profile]`/`platform:chat_id:thread_id`，可逗号组合

### 客户端实现要点（App 口径）

- 列表刷新：操作成功后重新拉 list 即可（无推送差异）；`cron.changed` 事件（§3）防抖 1s 静默刷新，仅在本会话加载过列表后响应。
- **trigger 是同步长操作**：UI 行级 busy + 请求超时放宽（App：`rpc/cron.ts` `TRIGGER_TIMEOUT_MS=10min`，D019 的 30s 统一超时不适用于此端点）；409 单独提示「任务正在运行」。
- `last_status ≠ ok` 不是失败一概而论：`delivery_failed` 的明细在 `last_delivery_error`；漏触发在 `last_fire_error`。错误展示优先级：last_fire_error > last_delivery_error > last_error。
- 运行历史行的打开 = **运行详情只读回放**（2026-09-10 修订，D039）：不再 `session.resume`（会挂起宿主 profile 的 agent，浏览历史不该有副作用）。改走 dashboard REST 只读端点 `GET /api/sessions/{session_id}/messages?profile=`（web_routers/sessions.py:658，`manage_router`，与 `/api/cron/*` 同 9119 同 token 中间件）：
  - 服务端 `read_only=True` 开库，先 `_resolve_session_id` + `resolve_resume_session_id`（自动解析压缩链到最新后代），会话不存在 404 `{detail}`；
  - 返回 `{session_id, messages: 原始行[], pagination: {limit, offset, order, returned}}`。**messages 是 messages 表 `SELECT *` 原始行**（role/content/timestamp/display_kind/active/compacted…），不是 gateway WS 侧投影（无 name/args 工具结构）；服务端只对压缩摘要行做 display 投影（有摘要 → 附 `display_content` 且摘掉 display_kind；无摘要 → `display_kind:"hidden"`）；
  - 分页：**省略 limit = 最新 500 条按时间序返回**（latest page chronological）；显式 limit 钳制 1..500，`order` 可 `oldest`/`latest`；
  - App 客户端投影（`rpc/restSessions.ts` `projectRunMessages`）：只留 user/assistant/system；`display_kind:"hidden"` 跳过；有 `display_content` 转 system 灰条；content 的 JSON parts 数组经 `coerceContentText`（复用 `ssh/remoteHistory.ts`）拍平；tool 行不渲染（与 foreign 只读视图同口径）。
  - 同族端点（App 未接）：`GET /api/sessions/{id}`（会话元信息）、`GET /api/sessions/{id}/export`。
- 对照警示：WS `cron.manage` 的 list 返回 `_format_job` 投影——字段名是 **`job_id`**（非 id）、prompt 只有 100 字符 preview、schedule 是 display 串。与 REST 原始记录不同，勿混用。
- **写路径验证用 mock gateway**（2026-09-08 新增）：`scripts/mock-gateway.js` 是本地内存态 gateway（HTTP `/` 带 token + `/api/health` + WS JSON-RPC，已实现 profiles.list / session.list / session.resume / session.history / complete.slash / slash.exec(title) / session.title / model.options），照真实服务端行为保真——`/title` 只改内存且**不推事件**。写操作类改动（改名/发送等）的端到端验证一律打它，不打 live 9119（AGENTS.md 禁写）。范例：`scripts/desktop-title-refresh-smoke.js`（真实 Electron + 隔离 userData）。
