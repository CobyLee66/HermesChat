# DECISIONS_ARCHIVE.md — 决策归档

> 从 DECISIONS.md 移入的已修订/已推翻条目（按 AGENTS.md 归档规则）。D0XX 锚点稳定，其他文档引用编号即可定位。

---

## 已归档条目

| D010 | SSH 连接 profile 化（多配置卡片 + 自动连接开关 + 全字段持久化 `hermes.connections.v2`），删除直连模式 | DirectWsTransport 链路不保留（web 调试直连走 `src/ssh/webDirect.ts` 独立路径） | 2026-09-02 |
| D020 | 语音识别语言问题**暂不处理**（用户 2026-09-05 决定）：识别语言完全由服务端决定，`/api/audio/transcribe` 无 language 参数，客户端无法指定 | 不改服务端（D003）；实测 faster-whisper `base` 自动检测把 ≤7s 中文全误判 `lang=en`（服务端日志实锤），要修只能用户自己改服务端配置（`stt.local.language: zh` / 换 `small` 模型）或给上游提 issue 加 language 参数；App 侧留待上游支持后再传语言 | 2026-09-05 |
