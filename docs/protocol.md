# Hermes serve 协议速查（App 开发用）

> 来源：本机 Hermes Agent v0.20.1 源码 + 实测。源码 ground truth（不确定时直接查）：
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
- token 获取（优先级）：`HERMES_DASHBOARD_SESSION_TOKEN` 环境变量（启动时注入）> `--ssh-session-token-file <path>` > 随机生成（注入 SPA HTML：`GET /` → 正则 `__HERMES_SESSION_TOKEN__="([^"]+)"`，已实测可用）。
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
- `session.resume` params `{session_id, profile?, cols?, omit_messages?}` → 重挂会话（含历史消息，除非 omit_messages）。错误码：4007=session not found、4130=transcript 过大（`sessions.max_resume_messages`）。
- `session.history` params `{session_id}` → `{count, messages}`。
- `session.delete` params `{session_id, profile?}`；`session.close` params `{session_id}` → `{"closed":true}`（删除活动会话报 4023，先 close）。**session.close 已实测**。
- `session.title`（改名）、`session.status`（返回 `{output}` 纯文本状态块）。
- ⚠️ **`session.info` 不是 RPC 方法**（tui_gateway 里无对应 `@method`），只是事件 + create/resume 结果里的 `info` 字段。会话信息弹层用缓存的 info 即可，不要 RPC 调用它。
- 会话"重开"：无专门 reset RPC。**已查源码确认方案 A 不可行**：`/reset` 是 `/new` 的别名（`hermes_cli/commands.py`，`gateway_only=True`），`slash.exec` 会把它路由到 slash worker 子进程里一个全新的 HermesCLI 实例执行，对 gateway 里的目标会话**没有影响**。→ 用方案 B：`session.create` 新会话（App 已按此实现，见 ChatScreen 注释）。
- `slash.exec` params `{session_id, command}`（**已从源码确认**，methods_tools.py:1108）→ `{output}`；命中 `_PENDING_INPUT_COMMANDS`（retry/queue/steer/goal/loop/undo/compress…）时转发 `command.dispatch` 返回 `{type:"send"|"exec"|...}`。

### profile / 模型 / 配置
- `profiles.list` → `{profiles: [{name, path, is_default, model, provider, description, skill_count, last_session, ui_meta?, has_avatar}]}`。**已实测**：返回外层确有 `profiles` 键（保留 `result.profiles ?? result` 兼容即可）；`last_session` 含 `{id,title,preview,started_at,last_active,message_count}` 或 null；本机 profile 均未设 `ui_meta`（昵称兜底顺序：ui_meta.nickname → description → name）。
- `profiles.get_asset` **已落实**（methods_profiles.py:866 + 实测）：params `{name, asset?="avatar"}` → `{found, mime?, size?, data?}`，`data` 是 `data:<mime>;base64,...` 可直接喂 `<Image source={{uri}}>`；无头像返回 `{found:false}`（**不是错误**，实测 main 即如此）→ 昵称首字符色块兜底。
- `profiles.configure` **已从源码确认**（methods_profiles.py:577）：params `{name, ...}`，其中 `ui_meta` 为 dict 时**键级合并**进 profile.yaml 的 ui_meta 块——值为 `null` 删除该键；整体 JSON ≤64KB（拒绝大 blob，头像走 set_asset）。昵称 = `profiles.configure {name, ui_meta:{nickname:"..."}}`。结果 `{ok, applied:{ui_meta:true|false,...}}`——分节独立应用，务必检查 `applied.ui_meta`。
- `profiles.set_asset` **已从源码确认**（methods_profiles.py:780）：params `{name, asset:"avatar", data}`（data URL 或裸 base64）→ `{ok, asset, size}`；删除 `{name, asset:"avatar", clear:true}` → `{ok, asset, size:0, removed}`。限制：PNG/JPEG/WebP（**magic-byte 校验**，不信声明的 mime）、解码后 ≤2MB；落盘为 profile 目录下 `assets/avatar.<ext>`（先清其他扩展名，一个 asset 一份文件）。
- `model.options` **已实测落实**：→ `{providers: [{slug, name, is_current, is_user_defined, models: string[], total_models, source, authenticated, auth_type, warning, capabilities, featured_models}], model, provider}`。按 provider 分组渲染 `models` 数组即可；注意 `session.info` 里 provider 是 `custom` 而 profiles/model.options 里可能带大小写不同的 `custom:DeepSeek` 形式。
- 切模型：`config.set` params `{key:"model", value:"<model> [--provider <slug>]", session_id}`（turn 进行中返回 `deferred:true`，defer 到下一 turn；其余字段 `{key,value,warning,confirm_required,confirm_message,scope}`）。读当前：`config.get` params `{key:"model"|"provider"|"full"|..., session_id?}`。

### 审批 / 交互（服务端阻塞等待应答）
- `approval.respond` params `{session_id, request_id?, choice:"once"|"session"|"always"|"deny", all?}` → `{resolved: <处理条数>}`。**已从源码确认**（methods_prompt.py:1404）。
- `approval.received` params `{session_id, request_id}` → `{acknowledged}`：UI 展示审批卡时回执（desktop 同款做法）。
- `clarify.respond {request_id, answer}`、`sudo.respond {password}`、`secret.respond {value}`。

### 附件（M3 已实现，全部从源码确认）
- `image.attach_bytes {session_id, content_base64, filename?, ext?}`（methods_prompt.py:823）→ `{attached, path, count, remainder:"", text, bytes, name, width?, height?, token_estimate?}`。远程客户端 base64 上传；`content_base64` 接受裸 base64 或 `data:image/...;base64,` 前缀（可含空白），解码后 ≤25MB（`_ATTACH_BYTES_MAX_BYTES`）。**扩展名优先采信 filename 后缀**，其次 magic bytes（PNG/JPEG/GIF/WebP/BMP）——所以客户端重编码成 JPEG 后必须把文件名改成 .jpg。写入 `<profile_home>/images/upload_<ts>_<n>.<ext>` 并进 session 的 `attached_images` 队列，**随下一条 `prompt.submit` 进上下文**；空文本 prompt 也合法（服务端补 "What do you see in this image?"）。错误码：4001 session not found、4015 缺参数、4016 不支持的扩展名、4017 非 base64/空、4018 超 25MB。
- `image.detach {session_id, path}` → `{detached, count}`：从队列摘除（path 须与 attach 返回的一致）。
- `file.attach {session_id, path?, data_url?, name?}`（methods_prompt.py:1010）→ `{attached, name, path, ref_path, ref_text, uploaded}`。非图片文件落盘到 session workspace 并返回 `@file:` 引用：`ref_text` 形如 `@file:attachments/…`（含空格时值带引号），**追加到输入框文本末尾**随 prompt 一起发，agent 的文件工具可据引用读取。path 与 data_url 二选一；远程客户端用 data_url（`data:<mime>;base64,…`）。
- REST `POST /api/audio/transcribe`（web_server.py:4637）：**请求体 JSON `{data_url, mime_type?}`；`profile` 是查询参数**（FastAPI 函数形参，不在 body 模型里——desktop 客户端同时放 query 和 body，真正生效的是 `?profile=`）。header 认证 `X-Hermes-Session-Token`。响应 `{ok:true, transcript, provider?}`；**未检测到语音不是错误**：返回 `{ok:true, transcript:""}`。失败为 HTTP 错误 + `{detail}`（400 非法 payload/非音频/非 base64/空、413 超 25MB、500 转写失败）。m4a（AAC）可用，mime 须 `audio/*`（或 video/webm）。
- REST 文件下载（渲染消息里的图片）：`GET /api/files/download?path=<gateway 绝对路径>&token=<SESSION_TOKEN>`（web_server.py:2630）——path 须为**绝对路径**（无 locked_root 时）；这是**唯一允许 `?token=` 查询参数认证**的路由（`_QUERY_TOKEN_API_PATHS`，desktop `mediaExternalUrl` 同款），RN `<Image>` 用它。⚠️ **不要用 `/api/files/stream`**：它 `media_only=True`，只放行音视频扩展名（.avi/.flac/.m4a/.mkv/.mov/.mp3/.mp4/.ogg/.opus/.wav/.webm），图片会 415。download 路由同样接受 header 认证，上限 100MB（`_MANAGED_FILE_MAX_BYTES`）。
- WS 帧上限 384MB（`_DESKTOP_ATTACHMENT_WS_MAX_BYTES`）——理论上限而已，客户端应先压缩再传（App：图片长边 2048 JPEG 80，头像 512×512 JPEG 80）。

## 3. 服务端事件（`params.type` → `params.payload`）

- 会话/生命周期：`gateway.ready`、`session.info`、`session.usage`、`session.reclaimed`、`session.seeded`、`session.title {session_id, title}`（首轮后服务端自动命名时推送，**实测出现**）、全局 `sessions.changed`。
- 消息流：`message.start`（payload 为空）→ `message.delta {text, rendered?}`（流式）→ `message.complete {text, usage, status?, rendered?, partial?, error?, reasoning?, warning?}`；`message.interim {text, already_streamed}`（工具回合间中间文本；`already_streamed=true` 表示文本已通过 delta 流出，客户端应密封当前文本段、后续 delta 开新段）。
- 思考/推理：`thinking.delta {text}`（可能带 `(⊙_⊙) reflecting...` 这类占位文本，也可能发空串）、`reasoning.delta {text}`、`reasoning.available {text}`（**实测其 text 是最终回复而非推理内容**，渲染可忽略）。
- 工具：`tool.start {tool_id, name, context, args?, args_text?}` —— 注意 80 字预览字段名是 **`context`**（不是 preview）；`tool.progress {tool_id?, preview?}`、`tool.complete {tool_id, name, args, result?, summary?, duration_s?, result_text?, inline_diff?, todos?}`、`tool.generating`、`tool.output_risk`。tool 卡片按 `tool_id` 合并 start/complete。
- 审批/交互请求：`approval.request {request_id, command(已脱敏), description, pattern_key, pattern_keys?, choices:["once","session","always","deny"], allow_permanent, allow_session?, smart_denied?}`（choices 由服务端按 smart_denied/allow_permanent 补齐）；`clarify.request`、`sudo.request`、`secret.request`。
- 状态/错误：`status.update {kind, text}`（kind 实测除 status/process/compacting/lifecycle/loop 外还有 `warn` 等，按字符串原样展示即可）、`error {message}`、`background.complete`。
- `usage` 实测结构（session.info / message.complete）：`{model, input, output, reasoning, prompt, completion, total, calls, context_used, context_max, context_percent, compressions, active_subagents}`。
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

## 5. 本机联调环境

- 本机已有一个 live dashboard：`127.0.0.1:9119`（`hermes dashboard --open-profile main`，qqbot 已连接，**是用户的真实环境，测试动作要克制**）。
- token：见上文 SPA 提取（当前实测值可复用，但 dashboard 重启会变，脚本应每次重新提取）。
- 实测 profile 列表：default、main(示例 agent，主助手)、finance(理财顾问)、mental-health(心理管家)、study(学习助手)、work(工作助理)。
- **纪律**：harness 全流程只允许一次真实 `prompt.submit`（用最小提示如"回复 pong 两个字即可"），用完 `session.close` 清理；其余测试用 jest mock。
