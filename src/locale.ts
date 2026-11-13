/** Shared presentation helpers. Never translate probe snapshots or caller-owned text. */
export type Locale = 'en' | 'zh'

/** Normalize an explicit language tag; unknown tags use the English dictionary. */
export function resolveLocale(value?: string): Locale {
  return /^zh(?:-|$)/i.test(value ?? '') ? 'zh' : 'en'
}

/** Negotiate the dashboard's two supported languages without treating unsupported tags as English. */
export function negotiateLocale(acceptLanguage: string | undefined, fallback: Locale = 'en'): Locale {
  if (acceptLanguage === undefined || acceptLanguage.trim() === '') return fallback
  const preferences: Array<{ range: string; quality: number; order: number }> = []
  for (const [order, entry] of acceptLanguage.split(',').entries()) {
    const [rawRange = '', ...parameters] = entry.trim().split(/\s*;\s*/)
    if (!/^(?:\*|[a-z]{1,8}(?:-[a-z0-9]{1,8})*)$/i.test(rawRange)) continue
    let quality = 1
    if (parameters.length > 0) {
      const weight = parameters.length === 1 ? /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i.exec(parameters[0]!) : null
      if (weight === null) continue
      quality = Number(weight[1])
    }
    preferences.push({ range: rawRange.toLowerCase().split('-')[0]!, quality, order })
  }
  preferences.sort((a, b) => b.quality - a.quality || a.order - b.order)
  const wildcard = preferences.find(preference => preference.range === '*')
  const candidates = ([fallback, fallback === 'en' ? 'zh' : 'en'] as const).map(locale => {
    // An explicit exclusion takes precedence over a wildcard for this language.
    const preference = preferences.find(preference => preference.range === locale) ?? wildcard
    return { locale, quality: preference?.quality ?? 0, order: preference?.order ?? Infinity }
  })
  candidates.sort((a, b) => b.quality - a.quality || a.order - b.order)
  // As before, unsupported/unacceptable headers use the English UI, not a 406 page.
  return candidates[0]!.quality > 0 ? candidates[0]!.locale : 'en'
}

/** Stable event data lets each viewer choose a language without rewriting the log. */
export type FireTrigger =
  | { readonly kind: 'change' }
  | { readonly kind: 'pattern'; readonly pattern: string; readonly match: string }
  | { readonly kind: 'session'; readonly sessionId: string; readonly turn: number; readonly reason: string }
  | { readonly kind: 'webhook' }
  /** Planned-deadline wakeup: no condition fire arrived before `deadline` (RFC 3339) and the watch was retired. */
  | { readonly kind: 'timeout'; readonly deadline: string }

export interface FireMessage {
  readonly summary: string
  readonly trigger?: FireTrigger
  readonly state?: string
}

const en = {
  snapshotChanged: 'Snapshot changed',
  patternMatched: 'Pattern /{pattern}/ started matching: {match}',
  webhookReceived: 'External push received (webhook)',
  sessionTurnEnded: 'Session {session} ended turn {turn} ({reason})',
  sessionTurnEndedNoTurn: 'Session {session} ended a turn ({reason})',
  reasonCompleted: 'completed',
  reasonMaxTokens: 'max-tokens',
  reasonAborted: 'aborted',
  reasonBlocked: 'blocked',
  reasonError: 'error',
  reasonInterrupted: 'interrupted',
  reasonForked: 'forked',
  withState: '{summary} (state: {state})',
  stateAbsent: 'absent',
  stateExists: 'exists',
  stateExistsBytes: 'exists ({bytes} bytes)',
  stateExit: 'exit {code}',
  stateUnreachable: 'unreachable',
  stateNoProcess: 'no process',
  stateProcesses: '{count} process(es)',
  stateOpen: 'open {address}',
  stateClosed: 'closed {address}',
  stateTimeout: 'timeout {address}',
  stateAwaitingPush: 'awaiting push',
  stateAwaitingTurn: 'awaiting turn end',
  stateTurnEnded: 'turn ended ({reason})',
  registered: 'Sentinel watch {id} registered: {kind} · {target}',
  hookAddress: 'Push URL: POST {url}',
  hookHost: ' (localhost refers to the dsh host; use its reachable address from another machine)',
  hookResident: ' — a resident dsh process must listen on this URL; a one-shot headless process cannot receive pushes after it exits',
  probeCadence: ' (probe every {interval}s{filePush}; server-side monitoring continues while the session sleeps; probing and wakeup delivery require a resident process such as dsh web after a one-shot headless process exits)',
  sessionCadence: ' (fires when the target session ends a turn; the host turn-end event drives it, no probing; the optional pattern filters the turn-end reason kind)',
  filePush: ', file changes also trigger immediate probes',
  noWatches: 'No active sentinel watches.',
  notProbed: 'not probed',
  listRow: '{id}: {kind} · {target} [{state}] fired {count}/{max}',
  listRowTimeout: '{id}: {kind} · {target} [{state}] fired {count}/{max} · timeout at {timeout}',
  cancelled: 'Watch {id} cancelled.',
  notFound: 'No active watch named {id}.',
  timeoutSummary: 'No condition fire before the planned deadline',
  timeoutArmed: ' · a timeout wakeup fires if nothing triggers within {seconds}s',
  wakeupTitle: '[dsh-sentinel] Watch {id} fired ({count}/{max})',
  wakeupTimeoutTitle: '[dsh-sentinel] Watch {id} timed out',
  wakeupTarget: 'Watching: {kind} · {target}',
  wakeupPattern: 'Pattern: /{pattern}/',
  wakeupTimeoutDeadline: 'Planned deadline: {deadline} ({elapsed}s after registration); nothing fired before it.',
  wakeupChange: 'Change: {summary}',
  wakeupBefore: 'Before:\n{before}',
  wakeupAfter: 'Now:\n{after}',
  wakeupTimeoutLast: 'Last observation:\n{last}',
  wakeupNote: 'The note you left when registering:\n{note}',
  wakeupInstruction: 'This is a sentinel condition wakeup: handle this fire according to the note, then stop. Unless the user or note asks, do not re-register the watch or start unrelated investigations.',
  wakeupTimeoutInstruction: 'This is a sentinel TIMEOUT wakeup: the watch never fired before its planned deadline and has been retired. Check whether the watched task is still running or making progress, and whether the watch was configured correctly (target, pattern, interval). Then tell the user what you found, or register a corrected watch with a new timeout. This wakeup is terminal: no further fire will arrive from this watch.',
  wakeupLast: 'This was the final fire; the watch has ended automatically.',
  wakeupRemaining: 'Remaining fires: {remaining}; if no longer needed, cancel with sentinel_cancel (id: "{id}").',
} as const

const zh: Record<keyof typeof en, string> = {
  snapshotChanged: '快照发生变化',
  patternMatched: '模式 /{pattern}/ 开始匹配: {match}',
  webhookReceived: '外部推送到达（webhook）',
  sessionTurnEnded: '会话 {session} 结束了第 {turn} 回合（{reason}）',
  sessionTurnEndedNoTurn: '会话 {session} 结束了一个回合（{reason}）',
  reasonCompleted: '完成',
  reasonMaxTokens: '达到输出上限',
  reasonAborted: '已中止',
  reasonBlocked: '已阻塞',
  reasonError: '出错',
  reasonInterrupted: '已中断',
  reasonForked: '已分叉',
  withState: '{summary}（状态: {state}）',
  stateAbsent: '不存在',
  stateExists: '存在',
  stateExistsBytes: '存在（{bytes} 字节）',
  stateExit: '退出码 {code}',
  stateUnreachable: '不可达',
  stateNoProcess: '无进程',
  stateProcesses: '{count} 个进程',
  stateOpen: '端口可达 {address}',
  stateClosed: '端口不通 {address}',
  stateTimeout: '探测超时 {address}',
  stateAwaitingPush: '等待推送',
  stateAwaitingTurn: '等待回合结束',
  stateTurnEnded: '回合已结束（{reason}）',
  registered: '哨兵订阅 {id} 已注册: {kind} · {target}',
  hookAddress: '推送地址: POST {url}',
  hookHost: '（localhost 指 dsh 所在主机，跨机器调用请换成该主机的可达地址）',
  hookResident: '——需常驻 dsh 进程监听该地址，一次性 headless 进程退出后无法接收推送',
  probeCadence: '（每 {interval}s 探测{filePush}；会话休眠时由服务端值守；探测与触发投递由常驻 dsh 进程承担——一次性 headless 进程退出后，需有常驻进程（如 dsh web）运行才会生效）',
  sessionCadence: '（该会话结束回合时触发；由宿主的回合结束事件驱动，不做探测；可选 pattern 过滤回合结束原因）',
  filePush: '，文件变化即时推送',
  noWatches: '没有活跃的哨兵订阅。',
  notProbed: '未探测',
  listRow: '{id}: {kind} · {target} [{state}] 触发 {count}/{max}',
  listRowTimeout: '{id}: {kind} · {target} [{state}] 触发 {count}/{max} · 超时时间 {timeout}',
  cancelled: '订阅 {id} 已取消。',
  notFound: '没有名为 {id} 的活跃订阅。',
  timeoutSummary: '计划截止时间前未触发',
  timeoutArmed: ' · {seconds}s 内无触发则触发一次超时唤醒',
  wakeupTitle: '[dsh-sentinel] 订阅 {id} 触发（第 {count}/{max} 次）',
  wakeupTimeoutTitle: '[dsh-sentinel] 订阅 {id} 超时未触发',
  wakeupTarget: '监控对象: {kind} · {target}',
  wakeupPattern: '匹配模式: /{pattern}/',
  wakeupTimeoutDeadline: '计划截止时间: {deadline}（注册后 {elapsed}s）；届时仍未触发。',
  wakeupChange: '变化: {summary}',
  wakeupBefore: '之前:\n{before}',
  wakeupAfter: '现在:\n{after}',
  wakeupTimeoutLast: '最后一次观测:\n{last}',
  wakeupNote: '你注册时留给自己的便签:\n{note}',
  wakeupInstruction: '以上是哨兵条件唤醒：按便签处理完本次触发即停；除非用户或便签要求，不要重新注册监控、不要展开无关调查。',
  wakeupTimeoutInstruction: '以上是哨兵超时唤醒：该监控在计划截止时间前始终没有触发，现已自动注销。请检查被监控的任务是否仍在运行/推进，以及监控配置（target、pattern、interval）是否正确；然后把情况告知用户，或重新注册一个修正后的监控（可带新的超时）。本次唤醒之后不会再有该监控的触发。',
  wakeupLast: '这是最后一次触发，该订阅已自动结束。',
  wakeupRemaining: '剩余 {remaining} 次触发额度；如果不再需要，用 sentinel_cancel 工具取消（id: "{id}"）。',
}

export const messages = { en, zh }
export type MessageKey = keyof typeof en

/** Canonical durable turn-end reason kinds → localized label keys. Unknown reasons pass through verbatim. */
const REASON_KEYS = {
  completed: 'reasonCompleted',
  'max-tokens': 'reasonMaxTokens',
  aborted: 'reasonAborted',
  blocked: 'reasonBlocked',
  error: 'reasonError',
  interrupted: 'reasonInterrupted',
  forked: 'reasonForked',
} as const satisfies Record<string, MessageKey>

/** Shared typed formatters, imported normally by the server, React client and standalone dashboard. */
export function createPresentation(locale: Locale, dictionary: Readonly<Record<MessageKey, string>>) {
  /** Callback replacement preserves literal dollar signs and does not re-interpolate values. */
  function translate(key: MessageKey, values: Readonly<Record<string, string | number>> = {}): string {
    return dictionary[key].replace(/\{(\w+)\}/g, (token, name: string) =>
      values[name] === undefined ? token : String(values[name]))
  }

  /** Turn-end reason labels are a closed host vocabulary; unknown future kinds stay verbatim. */
  function reasonLabel(reason: string): string {
    const key = (REASON_KEYS as Readonly<Record<string, MessageKey | undefined>>)[reason]
    return key === undefined ? reason : translate(key)
  }

  /** State is presentation-only: the canonical state and snapshot remain unchanged. */
  function localizeState(state: string): string {
    if (locale !== 'zh') return state
    if (state === 'absent') return translate('stateAbsent')
    if (state === 'exists') return translate('stateExists')
    const bytes = /^exists \((\d+) bytes\)$/.exec(state)
    if (bytes !== null) return translate('stateExistsBytes', { bytes: bytes[1]! })
    const exit = /^exit (-?\d+)$/.exec(state)
    if (exit !== null) return translate('stateExit', { code: exit[1]! })
    if (state === 'unreachable') return translate('stateUnreachable')
    if (state === 'no process') return translate('stateNoProcess')
    const processes = /^(\d+) process\(es\)$/.exec(state)
    if (processes !== null) return translate('stateProcesses', { count: processes[1]! })
    const port = /^(open|closed|timeout) (\([\s\S]*\))$/.exec(state)
    if (port !== null) {
      const key = port[1] === 'open' ? 'stateOpen' : port[1] === 'closed' ? 'stateClosed' : 'stateTimeout'
      return translate(key, { address: port[2]! })
    }
    if (state === 'awaiting push') return translate('stateAwaitingPush')
    if (state === 'awaiting turn end') return translate('stateAwaitingTurn')
    const turnEnded = /^turn ended \(([\s\S]*)\)$/.exec(state)
    if (turnEnded !== null) return translate('stateTurnEnded', { reason: reasonLabel(turnEnded[1]!) })
    return state
  }

  /** Recognize only plugin-owned legacy templates; unknown summaries stay verbatim. */
  function legacyFireMessage(summary: string): FireMessage {
    const suffix = /^(.*)（状态: ([\s\S]*)）$/s.exec(summary)
      ?? /^(.*) \(state: ([\s\S]*)\)$/s.exec(summary)
    const text = suffix?.[1] ?? summary
    const state = suffix?.[2]
    let trigger: FireTrigger | undefined
    if (text === '快照发生变化' || text === 'Snapshot changed') trigger = { kind: 'change' }
    else if (text === '外部推送到达（webhook）' || text === 'External push received (webhook)') trigger = { kind: 'webhook' }
    else {
      const prefix = text.startsWith('模式 /') ? '模式 /' : text.startsWith('Pattern /') ? 'Pattern /' : undefined
      if (prefix !== undefined) {
        const delimiter = prefix === '模式 /' ? '/ 开始匹配: ' : '/ started matching: '
        const body = text.slice(prefix.length)
        const boundary = body.indexOf(delimiter)
        // Legacy text has no escaping. If regex or match contains the delimiter,
        // preserve the entire summary instead of guessing and changing user data.
        if (boundary >= 0 && body.indexOf(delimiter, boundary + delimiter.length) < 0) {
          trigger = { kind: 'pattern', pattern: body.slice(0, boundary), match: body.slice(boundary + delimiter.length) }
        }
      }
    }
    return { summary, ...(trigger !== undefined ? { trigger, ...(state !== undefined ? { state } : {}) } : {}) }
  }

  function formatFireSummary(fact: FireMessage): string {
    const message = fact.trigger === undefined ? legacyFireMessage(fact.summary) : fact
    const trigger = message.trigger
    if (trigger === undefined) return fact.summary
    const summary = trigger.kind === 'change' ? translate('snapshotChanged')
      : trigger.kind === 'webhook' ? translate('webhookReceived')
        : trigger.kind === 'timeout' ? translate('timeoutSummary')
          : trigger.kind === 'session'
            ? (trigger.turn > 0
              ? translate('sessionTurnEnded', { session: trigger.sessionId, turn: trigger.turn, reason: reasonLabel(trigger.reason) })
              : translate('sessionTurnEndedNoTurn', { session: trigger.sessionId, reason: reasonLabel(trigger.reason) }))
            : translate('patternMatched', { pattern: trigger.pattern, match: trigger.match })
    return message.state === undefined ? summary
      : translate('withState', { summary, state: localizeState(message.state) })
  }
  return { translate, localizeState, legacyFireMessage, formatFireSummary }
}

export function translate(locale: Locale, key: MessageKey, values: Readonly<Record<string, string | number>> = {}): string {
  return createPresentation(locale, messages[locale]).translate(key, values)
}

export function localizeState(state: string, locale: Locale): string {
  return createPresentation(locale, messages[locale]).localizeState(state)
}

export function formatFireSummary(fact: FireMessage, locale: Locale): string {
  return createPresentation(locale, messages[locale]).formatFireSummary(fact)
}
