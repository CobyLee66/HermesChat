# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Streaming thinking/reasoning preview (collapsed) now anchors to the latest
  output: `thinkingTail` takes the measured preview width and slices a tail
  window sized to fit exactly two lines (CJK/ASCII aware), so the newest text
  is always visible at the end of line two. Previously the fixed 200-character
  window far exceeded two lines and `numberOfLines` tail truncation (the only
  direction supported by Android multiline and react-native-web line-clamp)
  ellipsized the newest output away, making the visible text appear to slide
  left and shrink while showing stale content.

## [0.1.0] - 2026-09-16

First tagged release of HermesChat — a cross-platform client for Hermes Agent
(`hermes serve` / `hermes dashboard`), speaking the official WS JSON-RPC + REST
protocol with no server-side modifications. Ships as an Android app, a
Windows/macOS desktop app (Electron), and a browser build for development.

### Added

#### Connections

- Two connection modes: an **SSH tunnel** to a remote machine running the
  Hermes gateway (self-built native SSH module with port forwarding on
  Android; `ssh2` in the Electron main process on desktop), and **direct**
  connections to an already-running gateway on the LAN.
- Multiple connection profiles with form validation, a single-choice
  auto-connect default, and credentials (private keys / passphrases) persisted
  locally on device.

#### Chat

- Multi-profile, multi-session chat with streaming output: text,
  thinking/reasoning, tool calls, and errors.
- Markdown rendering in assistant messages, including horizontally scrollable
  tables and images. Desktop/web supports drag-select that copies **Markdown
  source** plus a right-click "copy Markdown / plain text" menu; mobile has a
  long-press full-screen text selection layer with "copy all".
- Tool call cards with red/green diff rendering and `+N −M` badges for file
  edits; collapsible thinking blocks that show a live tail while streaming and
  collapse to a one-line preview when done.
- **Clarification cards** for agent questions (single or batch): a
  draft-style flow where selections/text stay local until a single
  "submit answers" action, answered cards keep their chronological position in
  the timeline, and history renders them as read-only answered cards.
- Permission **approval cards** for tool use.
- Slash command palette with completion (`/model` opens the in-app model
  picker, plus `/title`, `/reasoning`, `/help`, …); command output renders as
  system lines.
- Model picker with **reasoning-effort switching** (8 levels), available both
  in the picker and via `/reasoning`. The chat header shows
  model · context usage · reasoning effort and actively re-syncs when
  re-entering a session.
- In-chat message search (hit counter, next/prev jumping, highlighted hit) and
  session list search by title/summary.
- Session management: rename/delete from the chat menu, live title refresh,
  chat/automation/all filters, sort by recent activity or creation time.
- Cross-profile (e.g. QQ-sourced) conversations open **read-only** and derive
  a writable copy into the current profile on first send (session fork).
- Attachments: images (compressed before upload), files, and **voice input**
  (recorded on device, transcribed via the gateway STT endpoint). Profile
  avatars and nicknames are editable.
- Scroll behavior during streaming: auto-follow while pinned to the bottom,
  paused when scrolling up to read, a "back to bottom" pill, and
  snap-to-bottom on send.

#### Scheduled tasks (Cron)

- Cron job management backed by the dashboard REST API: browse with status
  badges and human-readable schedules, pause/resume, run now, per-run history
  with a read-only transcript replay, and a create/edit form with a schedule
  builder (interval / daily / weekly / monthly / one-off / raw cron) and
  delivery-target selection.

#### Desktop

- Windows/macOS Electron app sharing the same UI layer: responsive
  three/two/one-column layout, attachment dialogs, paste/drag-drop, voice
  recording, unfocused notifications, custom confirm dialogs, and keyboard
  shortcuts (Enter to send, Esc, Ctrl+N).
- Background resilience: app-suspension blockers plus periodic health probes
  so SSH connections survive long background idle periods.

#### i18n & project infra

- English and Simplified Chinese UI with a follow-system / manual language
  toggle (persisted), enforced by a dictionary-key CI check.
- GitHub Actions CI (TypeScript / ESLint / Jest / i18n check), bilingual
  README, SECURITY.md, CONTRIBUTING.md (DCO), issue/PR templates, and a mock
  gateway with Playwright smoke tests for regression coverage.

### Fixed

Notable issues resolved during the 0.1 development cycle:

- Sessions with a pending clarification failed to open with
  "iterator method is not callable" (the server sends a single pending object
  where the client expected a list).
- Sessions could vanish and sends could fail with "session not found" after
  the SSH tunnel dropped and the server recycled the live session. The app now
  follows the new session id after resume and auto-recovers in-flight sends,
  including recreating brand-new empty sessions that were never persisted.
- Clarification cards stayed pinned at the very bottom of the chat and each
  answer was sent immediately; answers are now drafted and submitted together,
  and the agent's follow-up output renders below the card.
- On Android, the input area could stay expanded after dismissing the keyboard
  while the agent was streaming (native IME-visibility reconciliation added).
- Thinking/tool cards could not be expanded with mouse clicks while content
  was streaming on web/desktop.
- The `/reasoning` slash command silently had no effect on the live session
  (it ran in a server worker subprocess); the client now intercepts it and
  applies the change through the config API.
- Tables in assistant messages could not be dragged horizontally on Android.
- Avatars showed a dark rounded-corner outline and replayed a fade-in
  animation on every list switch.
- Occasional "rpc not connected" errors when tapping a session right after a
  reconnect.
- Noticeable jump/jitter when first scrolling up in long chats.
- Re-entering a session mid-turn could lose thinking blocks and tool cards.
- Desktop: the window could appear blank/frozen after long background periods
  on macOS (App Nap), the window title stuck on a stale value, text
  drag-selection was blocked on message bubbles, and clipboard writes were
  silently denied.
- Deleting a cross-profile session reported "session not found" while the row
  stayed visible (delete is now routed to the database that physically owns
  the row).
- Voice transcription could hang forever on a half-open tunnel (timeouts
  added to all REST calls).

### Security

See [SECURITY.md](SECURITY.md) for reporting guidelines and known limitations
of this release: the APK is signed with the public debug keystore, desktop
packages are unsigned, and LAN tunnel/direct traffic is plaintext HTTP/WS by
design.

[Unreleased]: https://github.com/CobyLee66/HermesChat/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/CobyLee66/HermesChat/releases/tag/v0.1.0
