/**
 * en — 英文词典，界面文案键（MessageKey）的权威来源。
 *
 * 约定（详见 docs/i18n.md）：
 * - 新增 UI 文案先在本文件登记键，再同步 zh-CN.ts 中文（类型强制两表对齐，漏键 tsc 报错）；
 * - 键名 `<域>.<名称>`，域按界面/模块划分（common/chat/connection/...）；
 * - 占位符 `{name}`，由 interpolate 替换，缺参时保留占位符便于排查。
 */
export const en = {
  // ── 通用 ──
  'common.ok': 'OK',
  'common.cancel': 'Cancel',
  'common.edit': 'Edit',
  'common.delete': 'Delete',

  // ── Profile 列表 / 连接退出 ──
  'profile.disconnectTitle': 'Disconnect',
  'profile.disconnectConfirm': 'Disconnect from this host?',
  'profile.disconnect': 'Exit',
  'profile.reconnecting': 'Connection lost, reconnecting…',
  'profile.loadFailed': 'Failed to load: {error}',
  'profile.retry': 'Retry',
  'profile.skillCount': '{count} skills',

  // ── 语言切换 ──
  'settings.language': 'Language',
  'settings.lang.auto': 'System',
  // 语言名用各自的叫法（endonym），不随界面语言翻译
  'settings.lang.zh': '中文',
  'settings.lang.en': 'EN',

  // ── 会话 ──
  'session.untitled': 'Untitled session',

  // ── 连接表单校验 ──
  'validation.gatewayHostRequired': 'Gateway host is required',
  'validation.sshHostRequired': 'SSH host is required',
  'validation.portRequired': 'Port is required',
  'validation.portInvalid': 'Port must be an integer between 1 and 65535',
  'validation.usernameRequired': 'SSH username is required',
  'validation.authRequired': 'Provide a password or a private key',

  // ── 图片处理 ──
  'media.noDocument': 'document is unavailable in this environment',
  'media.decodeFailed': 'Failed to decode image (unsupported format?)',
  'media.noCanvasContext': 'canvas 2d context is unavailable',
  'media.localPathUnsupported':
    'Reading files from local paths is not supported on web',

  // ── 定时任务 ──
  'cron.modeInterval': 'Interval',
  'cron.modeDaily': 'Daily',
  'cron.modeWeekly': 'Weekly',
  'cron.modeMonthly': 'Monthly',
  'cron.modeOnce': 'One-off',
  'cron.modeCustom': 'Custom',
  'cron.weekday0': 'Sun',
  'cron.weekday1': 'Mon',
  'cron.weekday2': 'Tue',
  'cron.weekday3': 'Wed',
  'cron.weekday4': 'Thu',
  'cron.weekday5': 'Fri',
  'cron.weekday6': 'Sat',
  'cron.listSep': ', ',
  'cron.everyWeekday': 'Weekly on {days} at {time}',
  'cron.monthDays': 'Monthly on day {days} at {time}',
  'cron.dailyTime': 'Daily at {time}',
  'cron.everyDays': 'Every {n} days',
  'cron.everyHours': 'Every {n} hours',
  'cron.everyMinutes': 'Every {n} minutes',
  'cron.onceAt': 'One-off · {time}',
  'cron.repeatForever': 'Forever',
  'cron.once': 'One-off',
  'cron.repeatDone': '{done}/{total} done',
  'cron.repeatTimes': '{count} runs',

  // ── 定时任务表单 ──
  'cron.nameOptional': 'Name (optional)',
  'cron.namePlaceholder': 'Leave empty to use the prompt prefix',
  'cron.prompt': 'Prompt',
  'cron.promptPlaceholder': 'Instruction the agent receives on each run',
  'cron.promptRequired': 'Prompt is required',
  'cron.promptRequiredHint':
    'The self-contained instruction the agent receives on each scheduled run',
  'cron.schedule': 'Schedule',
  'cron.everyPrefix': 'Every',
  'cron.unitMinute': 'min',
  'cron.unitHour': 'hr',
  'cron.unitDay': 'day',
  'cron.monthlyDayPrefix': 'Monthly, day',
  'cron.monthlyDaySuffix': '',
  'cron.modeLabel': 'Mode',
  'cron.modePickerTitle': 'Schedule mode',
  'cron.scheduleIncomplete': 'Schedule incomplete',
  'cron.onceTimeRequired':
    'Enter the one-off run time (YYYY-MM-DD HH:mm)',
  'cron.scheduleFieldsRequired': 'Fill in all schedule fields',
  'cron.deliveryTarget': 'Delivery target',
  'cron.ownerProfile': 'Owner profile',
  'cron.pickProfile': 'Pick a profile',
  'cron.continuity':
    'Follow last output (inject the job\u2019s previous result)',
  'cron.homeChannelMissing': 'home channel not configured',
  'cron.save': 'Save',
  'cron.saving': 'Saving…',
  'cron.saveFailed': 'Save failed',
  'cron.notConnected': 'Not connected to the gateway',
  'cron.customPlaceholder': 'cron expression, e.g. 0 9 * * 1-5',

  // ── 定时任务面板 ──
  'cron.stateScheduled': 'Scheduled',
  'cron.statePaused': 'Paused',
  'cron.stateCompleted': 'Completed',
  'cron.stateError': 'Error',
  'cron.statusRunError': 'Run failed',
  'cron.statusDeliveryFailed': 'Delivery failed',
  'cron.statusBlockedConfig': 'Blocked by config',
  'cron.missedFire': 'Missed fire ({at}): {detail}',
  'cron.deliveryFailedDetail': 'Delivery failed: {detail}',
  'cron.allProfiles': 'All profiles',
  'cron.new': '＋ New',
  'cron.count': 'Cron jobs ({count})',
  'cron.loadFailed': 'Failed to load: {error}',
  'cron.retry': 'Retry',
  'cron.empty': 'No cron jobs',
  'cron.opFailed': 'Action failed',
  'cron.jobRunning': 'Job is running',
  'cron.jobRunningHint':
    'The previous run hasn\u2019t finished. Try again later.',
  'cron.triggerFailed': 'Trigger failed',
  'cron.deleteTitle': 'Delete cron job',
  'cron.deleteConfirm': 'Delete \u201C{name}\u201D? This cannot be undone.',
  'cron.deleteFailed': 'Delete failed',
  'cron.resumeSchedule': 'Resume',
  'cron.pauseSchedule': 'Pause',
  'cron.runningNow': 'Running…',
  'cron.runNow': 'Run now',
  'cron.runs': 'Run history',
  'cron.runRecord': 'Run',
  'cron.viewRunDetail': 'View run details',
  'cron.runActive': 'Running',
  'cron.runDone': 'Finished',
  'cron.runTimespan': 'Started {start}    Last activity {last}',
  'cron.openInChat': 'Open in chat',
  'cron.runEmpty': 'This run produced no conversation',
  'cron.runsEmpty': 'No runs yet',
  'cron.nextLastRun': 'Next {next}    Last {last}',
  'cron.jobMissing': 'Job not found or deleted: {error}',

  // ── 连接状态机 ──
  'conn.connectorMissing': 'connector not initialized',
  'conn.noActiveProfile': 'No active connection profile',
  'conn.healthFailDrop':
    'Health probe failed repeatedly: tunnel not responding',
  'conn.foregroundProbeFail':
    'Foreground health probe failed: tunnel not responding',
  'conn.notConnected': 'Not connected',
  'conn.recoveryTimeout': 'Connection recovery timed out. Try again later.',

  // ── 聊天时间线错误 ──
  'chat.sendFailed': 'Send failed: {message}',
  'chat.sessionRecovered':
    'Connection was interrupted; the session was recovered automatically.',
  'chat.sshRequiredForHistory':
    'An SSH connection is required to read this session\u2019s history',
  'chat.forkFailed': 'Fork to current profile failed: {message}',
  'chat.imageUploadFailed': 'Image upload failed: {message}',
  'chat.imageRemoveFailed': 'Failed to remove image: {message}',
  'chat.interruptFailed': 'Interrupt failed: {message}',
  'chat.approvalFailed': 'Failed to answer approval: {message}',
  'chat.clarifyFailed': 'Failed to answer clarification: {message}',

  // ── Profile ──
  'profiles.nicknameWriteFailed':
    'Failed to write nickname (server did not apply ui_meta)',

  // ── RPC / REST 通用 ──
  'rpc.requestFailedHttp': 'Request failed (HTTP {status})',
  'rpc.requestTimeout':
    'Request timed out ({seconds}s). Check your connection and retry.',
  'rpc.transcribeFailedHttp': 'Voice transcription failed (HTTP {status})',
  'rpc.transcribeTimeout':
    'Voice recognition timed out ({seconds}s). Check your connection and retry.',
  'rpc.unknownError': 'Unknown error',

  // ── 斜杠命令 ──
  'slash.empty': 'Empty slash command',
  'slash.noOutput': '/{name}: no output',
  'slash.warning': 'Warning: {warning}\n{body}',
  'slash.invalidDispatch':
    'Error: command.dispatch returned an invalid response',
  'slash.noneOutput': '(no output)',
  'slash.skillMissingMessage': 'skill is missing its payload message',
  'slash.dispatchEmpty': 'dispatch message is empty',
  'slash.skillLoaded': '⚡ Loading skill: {name}',
  'slash.error': 'Error: {message}',
  'slash.completeLabel': 'Complete {name}',

  // ── SSH / 传输层 ──
  'ssh.moduleUnavailable':
    'SSH native module unavailable (Android build required)',
  'ssh.tokenNotFound': 'Could not obtain the remote session token',
  'ssh.hermesNotFound':
    'hermes executable not found on the remote host: not in PATH, login shell, or common install locations (~/.local/bin, ~/.hermes/bin, /usr/local/bin, /opt/homebrew/bin).',
  'ssh.readyTimeout': 'Timed out waiting for HERMES_BACKEND_READY',
  'ssh.serveExited': 'Remote hermes serve exited (code={code}): {tail}',
  'ssh.tokenExtractFail':
    'Could not extract the session token from the gateway home page. Fill it in manually in the connection settings.',
  'ssh.gatewayHttp': 'Failed to reach the gateway (HTTP {status})',
  'ssh.gatewayUnreachable': 'Cannot reach the gateway ({url}): {message}',
  'ssh.desktopBridgeUnavailable':
    'Desktop SSH bridge unavailable (Electron shell required)',
  'ssh.noWindowLocation': 'window.location is unavailable',
  'ssh.bridgeUnavailableShort':
    'Desktop bridge unavailable (Electron shell required)',
  'ssh.remoteHistoryFailed':
    'Failed to read remote session history (sqlite3 exit={code}): {stderr}',
  'ssh.webDirectName': 'Direct connect (local 127.0.0.1:9119)',
  'ssh.webDirectWebOnly': 'Direct connect is only available in the web build',
  'ssh.webDirectNeedsLocation': 'Direct connect requires window.location',
  'ssh.dashboardHttp': 'Failed to fetch the dashboard page (HTTP {status})',
  'ssh.dashboardTokenNotFound':
    'Could not extract the session token from the dashboard page',
  'ssh.tunnelUnsupported':
    'SSH tunnels are not supported in the browser. Use the direct connect entry.',
  'ssh.bridgeUnavailableEnv':
    'SSH bridge is unavailable in this environment ({method}). Desktop requires the Electron shell; in a browser use direct connect.',

  // ── 审批卡 ──
  'approval.title': '🛡 Permission approval',
  'approval.expired': 'Expired; the server is no longer waiting',
  'approval.resolved': 'Selected: {choice}',
  'approval.once': 'Allow once',
  'approval.session': 'Allow this session',
  'approval.always': 'Always allow',
  'approval.deny': 'Deny',

  // ── 澄清卡 ──
  'clarify.title': '💬 Your answer is needed',
  'clarify.answered': 'Answered',
  'clarify.yourAnswer': 'Your answer',
  'clarify.submit': 'Submit answers',
  'clarify.pendingCount': '{count} question(s) unanswered',

  // ── 聊天界面 ──
  'chat.defaultTitle': 'Chat',
  'chat.multiHint': '(multiple choice)',
  'chat.answerPlaceholder': 'Or type your answer…',
  'chat.thinking': 'Thinking',
  'chat.reasoning': 'Reasoning',
  'chat.currentModel': '(current)',
  'chat.diffTruncated': '… truncated ({count} lines total)',
  'chat.outputTruncated': '\n… (truncated)',
  'tool.args': 'Args',
  'tool.result': 'Result',

  // ── 模型切换 ──
  'model.switchTitle': 'Switch model',
  'model.loadFailed': 'Failed to load: {error}',
  'model.empty': 'No models available',
  'model.more': '… {count} total',
  'model.reasoningTitle': 'Thinking level',

  // ── Markdown 复制菜单（web） ──
  'md.copyMarkdown': 'Copy Markdown',
  'md.copyPlain': 'Copy plain text',

  // ── 错误边界 ──
  'errorBoundary.title': 'Something went wrong',
  'errorBoundary.reload': 'Reload',

  // ── 通用（补） ──
  'common.rename': 'Rename',
  'chat.toggleDetailShow': 'Show tools & thinking',
  'chat.toggleDetailHide': 'Hide tools & thinking',
  'chat.switchFailed': 'Switch failed',
  'chat.reasoningSet': '✓ Reasoning effort set to {level}',
  'chat.reasoningSetGlobal':
    '✓ Reasoning effort set to {level} (saved to global config)',
  'chat.reasoningSetFailed': 'Failed to set reasoning level: {error}',
  'chat.infoModel': 'Model',
  'chat.infoProvider': 'Provider',
  'chat.infoTokenUsage': 'Token usage',
  'chat.tokenSessionTotal': '{count} (accumulated this connection)',
  'chat.infoContextWindow': 'Context window',
  'chat.infoWorkdir': 'Working directory',
  'chat.infoBranch': 'Branch',
  'chat.unknown': 'Unknown',
  'chat.renamePlaceholder': 'Enter a new session title',
  'chat.sessionRecycled':
    'This session was reclaimed by the server. Pick another one.',
  'chat.sessionRecycledBack':
    'This session was reclaimed by the server. Go back and re-enter.',
  'chat.forkingBanner': 'Forking to the current profile…',
  'chat.foreignBanner':
    'QQ-sourced session · sending will fork it into the current profile',
  'chat.jumpToBottom': '↓ Back to bottom',
  'chat.close': 'Close',
  'chat.infoTitle': 'Session info',
  'chat.menuSearch': 'Search chat history',
  'chat.rename': 'Rename session',
  'chat.contextPercent': ' ({percent}%)',

  // ── 输入区 ──
  'input.pickImageFailed': 'Failed to pick image',
  'input.addFileFailed': 'Failed to add file',
  'input.attachPanelCollapse': 'Collapse attachments panel',
  'input.attachPanelOpen': 'Open attachments panel',
  'input.placeholder': 'Message…',
  'input.sendImage': 'Send image',
  'input.sendFile': 'Send file',
  'input.interrupt': 'Interrupt',
  'input.send': 'Send',
  'input.attaching': 'Uploading attachment…',

  // ── 会话列表 / 会话流程 ──
  'view.sessions': 'Sessions',
  'view.cron': 'Cron jobs',
  'session.filterChats': 'Chats',
  'session.filterAutomation': 'Automation',
  'session.filterAll': 'All',
  'session.sortRecent': 'Recent activity',
  'session.sortCreated': 'Creation time',
  'session.openFailed': 'Failed to open session',
  'session.searchPlaceholder': 'Search titles / previews',
  'session.emptyAll': 'No sessions yet. Tap \u201CNew chat\u201D to start.',
  'session.emptySearch': 'No sessions match your search',
  'session.emptyFilter': 'No sessions in this category',
  'session.messageCount': '{count} messages',
  'session.newTitle': 'New chat',
  'session.deleteTitle': 'Delete session',
  'session.deleteConfirm': 'Delete \u201C{name}\u201D?',
  'session.deleteFailed': 'Delete failed',
  'session.renameFailed': 'Rename failed',

  // ── 搜索栏 ──
  'search.placeholder': 'Search',
  'search.noHit': 'No matches',

  // ── 语音输入 ──
  'voice.title': 'Voice input',
  'voice.micPermissionTitle': 'Microphone permission',
  'voice.micPermissionMessage': 'Voice input needs microphone access',
  'voice.allow': 'Allow',
  'voice.deny': 'Deny',
  'voice.recognizeTimeout':
    'Voice recognition timed out ({seconds}s). Try again.',
  'voice.micDenied': 'Cannot record',
  'voice.micDeniedHint': 'Allow microphone access in system settings',
  'voice.noSpeech': 'No speech detected',
  'voice.recognizeFailed': 'Voice recognition failed',
  'voice.recordFailed': 'Recording failed',
  'voice.readFailed': 'Failed to read recording data',
  'voice.micUnsupported':
    'Microphone capture is not supported in this environment',
  'voice.recorderMissing': 'Recorder not available',
  'voice.busy': 'Recognizing…',

  // ── 桌面壳 ──
  'desktop.bridgeUnavailable': 'Desktop bridge unavailable',
  'desktop.copyTitle': 'Copy session title',
  'desktop.pickImageFailed': 'Failed to load image',
  'desktop.newSessionFailed': 'Failed to create session',
  'desktop.readFileUnsupported':
    'Reading files is not supported in this environment',
  'desktop.readFileFailed': 'Failed to read file',
  'desktop.pasteImageName': 'pasted-image-{stamp}-{n}',
  'desktop.pasteImageFailed': 'Failed to paste image',
  'desktop.imageName': 'image-{stamp}',
  'desktop.addAttachFailed': 'Failed to add attachment',
  'desktop.searchPlaceholder': 'Search chat history',
  'desktop.openProfileLabel': 'Open profile {name}',
  'desktop.runsTitle': 'Run history · {name}',
  'desktop.emptyChat': 'Pick a session from the list',
  'desktop.emptyChatHint': 'Or click \u201CNew chat\u201D in the top-left to start one',
  'notify.replyDone': 'Session reply completed',

  // ── 导航标题 ──
  'nav.home': 'Connect',
  'nav.editConnection': 'Edit connection',
  'nav.addConnection': 'Add connection',
  'nav.profileEdit': 'Edit profile',
  'nav.runs': 'Run history',
  'nav.runDetail': 'Run details',
  'nav.cronEdit': 'Cron jobs',
  'nav.cronEditJob': 'Edit cron job',
  'nav.cronNewJob': 'New cron job',

  // ── 连接编辑表单 ──
  'common.save': 'Save',
  'conn.nameLabel': 'Profile name',
  'conn.namePlaceholderDirect': 'e.g. local gateway',
  'conn.namePlaceholderSsh': 'e.g. office server',
  'conn.typeLabel': 'Connection type',
  'conn.typeSsh': 'SSH tunnel',
  'conn.typeDirect': 'Direct',
  'conn.gatewayHost': 'Gateway host',
  'conn.port': 'Port',
  'conn.tokenLabel': 'Session token (optional)',
  'conn.tokenPlaceholder':
    'Leave empty to extract from the gateway home page',
  'conn.directHint':
    'The gateway must be listening on this address; LAN direct connections require hermes serve to listen on 0.0.0.0',
  'conn.webDirectHint':
    'Browsers are restricted by CORS: only local 127.0.0.1:9119 is supported (via the dev server proxy)',
  'conn.sshHost': 'SSH host',
  'conn.hostPlaceholderSsh': 'e.g. 192.168.1.10',
  'conn.username': 'Username',
  'conn.usernamePlaceholder': 'e.g. root',
  'conn.password': 'Password',
  'conn.passwordPlaceholder': 'Leave empty when using a private key',
  'conn.privateKeyLabel':
    'Private key (optional, takes precedence over password)',
  'conn.keySelected': 'Selected: {name}',
  'conn.pickKeyFile': 'Choose key file',
  'conn.keyFileChosen': 'Selected',
  'conn.privateKeyPlaceholder':
    'Paste PEM content, or pick a file with the button above',
  'conn.passphraseLabel': 'Key passphrase (optional)',
  'conn.passphrasePlaceholder': 'Fill in if the key has a passphrase',
  'conn.keyFileReadFailed': 'Failed to read key file',
  'conn.unnamedProfile': 'Unnamed profile',
  'conn.cannotSave': 'Cannot save',
  'conn.deleteTitle': 'Delete profile',
  'conn.deleteConfirm': 'Delete \u201C{name}\u201D?',
  'conn.subtitle': 'Pick a profile to connect to your Hermes Agent',
  'conn.empty': 'No connection profiles yet. Add one below.',
  'conn.tagDefault': 'Default',
  'conn.autoConnect': 'Auto connect',
  'conn.webDirectButton': '⚡ Direct connect (local 127.0.0.1:9119)',
  'conn.addProfile': '＋ Add profile',

  // ── Profile 编辑 ──
  'profile.changeAvatar': 'Change avatar',
  'profile.resetAvatar': 'Reset',
  'profile.resetAvatarTitle': 'Reset avatar',
  'profile.resetAvatarMessage':
    'This deletes the custom avatar and falls back to the initial-colored block.',
  'profile.avatarChangeFailed': 'Failed to change avatar',
  'profile.nickname': 'Nickname',
  'profile.nicknameHint':
    'Leave empty to use the default display name ({name})',
  'profile.saved': 'Saved',
  'profile.nicknameUpdated': 'Nickname updated',
  'profile.saveFailed': 'Save failed',
  'common.opFailed': 'Action failed',

  // ── 聊天选择工具条 ──
  'chat.copied': 'Copied ✓',
  'chat.copyAll': 'Copy all',

  // ── 通用弹层 ──
  'common.gotIt': 'Got it',
  'common.back': '‹ Back',
} as const;

export type MessageKey = keyof typeof en;
/** 插值参数表：模板 `{name}` ← params.name。 */
export type MessageParams = Record<string, string | number>;
