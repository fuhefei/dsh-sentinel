/**
 * Sentinel domain: subscription records, the sentinel/change event codec, and
 * the pure fold that rebuilds live subscriptions from a session's event log.
 *
 * Follows the tool-schedule pattern: every mutation is one appended
 * `sentinel/change` session event; runtime state is always a fold over the
 * log, so subscriptions survive restarts and stay fully auditable.
 */

export const SENTINEL_CHANGE_TYPE = 'sentinel/change'
export const SENTINEL_CHANGE_VERSION = 1

/** Probe engines the runtime knows how to drive. `webhook` is push-only: no probing, external callers POST to the hook route. */
export type SensorKind = 'file' | 'command' | 'http' | 'process' | 'port' | 'webhook'

/** What the agent asked to watch, all data, no code. */
export interface SensorSpec {
  readonly kind: SensorKind
  /** file: absolute path; command: shell line; http: URL; process: pgrep pattern; port: "[host:]port"; webhook: human label for the expected caller. */
  readonly target: string
  /** Optional regex (source string). Probe kinds: fire on no-match → match transitions. webhook: fire only when the posted payload matches. */
  readonly pattern?: string
  /** Seconds between probes (ignored for webhook). Clamped to [5, 86400]. */
  readonly intervalSeconds: number
}

/** One persisted probe observation: enough to re-seed change detection after resume. */
export interface KnownSnapshot {
  /** Sensor state word at observation time (e.g. `exists`, `absent`, `exit=0`). */
  readonly state: string
  /** Full bounded probe snapshot (sensors already clamp size). */
  readonly snapshot: string
}

/** One durable subscription as folded from the log. */
export interface Subscription {
  readonly id: string
  readonly spec: SensorSpec
  /** Mandatory continuation note: what future-self should do when this fires. */
  readonly note: string
  /** Stop after this many fires. */
  readonly maxFires: number
  /** Seconds to stay silent after a fire. */
  readonly cooldownSeconds: number
  /** RFC 3339 expiry; undefined = lives until cancelled. */
  readonly expiresAt?: string
  /** RFC 3339 creation instant. */
  readonly createdAt: string
  /** Fires recorded so far (folded). */
  readonly fireCount: number
  /** Last fire instant, if any (folded). */
  readonly lastFiredAt?: string
  /** Last persisted observation; seeds the probe baseline after resume (folded). */
  readonly lastKnown?: KnownSnapshot
}

/** Payload shapes carried by sentinel/change session events. */
export type SentinelChange =
  | {
    readonly version: number
    readonly change: 'created'
    readonly subscription: {
      readonly id: string
      readonly spec: SensorSpec
      readonly note: string
      readonly maxFires: number
      readonly cooldownSeconds: number
      readonly expiresAt?: string
      readonly createdAt: string
    }
  }
  | {
    readonly version: number
    readonly change: 'baseline'
    readonly id: string
    readonly at: string
    readonly observed: KnownSnapshot
  }
  | {
    readonly version: number
    readonly change: 'fired'
    readonly id: string
    readonly at: string
    readonly fact: FireFact
    /** Post-fire observation; re-seeds the probe baseline after resume. */
    readonly observed?: KnownSnapshot
  }
  | {
    readonly version: number
    readonly change: 'cancelled'
    readonly id: string
    readonly at: string
    readonly reason: 'agent' | 'expired' | 'exhausted'
  }
  | {
    readonly version: number
    /**
     * Boot-time compaction artifact: one row replacing a session's whole
     * history, carrying the subscription exactly as folded (fire budget and
     * last observation included). Old readers reject it as an unknown change.
     */
    readonly change: 'compacted'
    readonly subscription: {
      readonly id: string
      readonly spec: SensorSpec
      readonly note: string
      readonly maxFires: number
      readonly cooldownSeconds: number
      readonly expiresAt?: string
      readonly createdAt: string
      readonly fireCount: number
      readonly lastFiredAt?: string
      readonly lastKnown?: KnownSnapshot
    }
  }

/** The structured trigger fact delivered with a wakeup (and logged). */
export interface FireFact {
  /** Ordinal of this fire for its subscription (1-based). */
  readonly fireNumber: number
  /** Human-readable one-line transition summary. */
  readonly summary: string
  /** Snapshot excerpt before the transition (may be empty on baseline). */
  readonly before: string
  /** Snapshot excerpt after the transition. */
  readonly after: string
  /** Probe duration in milliseconds. */
  readonly probeMs: number
}

export class SentinelLogError extends Error {
  override name = 'SentinelLogError'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate a persisted probe observation ({@link KnownSnapshot}). */
function decodeObserved(value: unknown): KnownSnapshot {
  if (!isRecord(value) || typeof value['state'] !== 'string' || typeof value['snapshot'] !== 'string') {
    throw new SentinelLogError('observed snapshot must carry string state and snapshot')
  }
  return { state: value['state'], snapshot: value['snapshot'] }
}

const SENSOR_KINDS: readonly SensorKind[] = ['file', 'command', 'http', 'process', 'port', 'webhook']

export const MIN_INTERVAL_SECONDS = 5
export const MAX_INTERVAL_SECONDS = 86_400
export const MAX_SUBSCRIPTIONS_PER_AGENT = 16
export const MAX_NOTE_LENGTH = 2000
export const MAX_EXCERPT_LENGTH = 640

/** Validate and normalize an agent-provided sensor spec; throws on nonsense. */
export function normalizeSpec(value: unknown): SensorSpec {
  if (!isRecord(value)) throw new SentinelLogError('sensor spec must be an object')
  const kind = value['kind']
  if (typeof kind !== 'string' || !SENSOR_KINDS.includes(kind as SensorKind)) {
    throw new SentinelLogError(`sensor kind must be one of ${SENSOR_KINDS.join(', ')}`)
  }
  const target = value['target']
  if (typeof target !== 'string' || target.trim() === '') {
    throw new SentinelLogError('sensor target must be a non-empty string')
  }
  if (kind === 'port') {
    const match = /^(?:([^:\s]+):)?(\d{1,5})$/.exec(target.trim())
    const port = match === null ? Number.NaN : Number(match[2])
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new SentinelLogError('port target must be "[host:]port" with a port in 1-65535')
    }
  }
  const pattern = value['pattern']
  if (pattern !== undefined) {
    if (typeof pattern !== 'string' || pattern === '') throw new SentinelLogError('pattern must be a non-empty string when present')
    try {
      void new RegExp(pattern)
    } catch {
      throw new SentinelLogError(`pattern is not a valid regular expression: ${pattern}`)
    }
  }
  const rawInterval = value['intervalSeconds']
  const interval = typeof rawInterval === 'number' && Number.isFinite(rawInterval)
    ? Math.round(rawInterval)
    : 30
  const clamped = Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, interval))
  return {
    kind: kind as SensorKind,
    target: target.trim(),
    ...(pattern !== undefined ? { pattern } : {}),
    intervalSeconds: clamped,
  }
}

/** Decode one sentinel/change payload; throws SentinelLogError on corrupt rows. */
export function decodeSentinelChange(value: unknown): SentinelChange {
  if (!isRecord(value)) throw new SentinelLogError('sentinel/change payload must be an object')
  const version = value['version']
  if (version !== SENTINEL_CHANGE_VERSION) {
    throw new SentinelLogError(`unsupported sentinel/change version: ${String(version)}`)
  }
  const change = value['change']
  if (change === 'created') {
    const sub = value['subscription']
    if (!isRecord(sub)) throw new SentinelLogError('created change must carry a subscription object')
    const id = sub['id']
    const note = sub['note']
    const createdAt = sub['createdAt']
    if (typeof id !== 'string' || id === '') throw new SentinelLogError('subscription id must be a non-empty string')
    if (typeof note !== 'string' || note === '') throw new SentinelLogError('subscription note must be a non-empty string')
    if (typeof createdAt !== 'string') throw new SentinelLogError('subscription createdAt must be a string')
    const maxFires = sub['maxFires']
    const cooldown = sub['cooldownSeconds']
    if (typeof maxFires !== 'number' || !Number.isInteger(maxFires) || maxFires < 1) {
      throw new SentinelLogError('maxFires must be a positive integer')
    }
    if (typeof cooldown !== 'number' || !Number.isInteger(cooldown) || cooldown < 0) {
      throw new SentinelLogError('cooldownSeconds must be a non-negative integer')
    }
    const expiresAt = sub['expiresAt']
    if (expiresAt !== undefined && typeof expiresAt !== 'string') {
      throw new SentinelLogError('expiresAt must be a string when present')
    }
    return {
      version: SENTINEL_CHANGE_VERSION,
      change: 'created',
      subscription: {
        id,
        spec: normalizeSpec(sub['spec']),
        note,
        maxFires,
        cooldownSeconds: cooldown,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        createdAt,
      },
    }
  }
  if (change === 'baseline') {
    const id = value['id']
    const at = value['at']
    if (typeof id !== 'string' || typeof at !== 'string') {
      throw new SentinelLogError('baseline change must carry id and at')
    }
    return { version: SENTINEL_CHANGE_VERSION, change: 'baseline', id, at, observed: decodeObserved(value['observed']) }
  }
  if (change === 'fired') {
    const id = value['id']
    const at = value['at']
    const fact = value['fact']
    if (typeof id !== 'string' || typeof at !== 'string' || !isRecord(fact)) {
      throw new SentinelLogError('fired change must carry id, at, and fact')
    }
    const observed = value['observed']
    return {
      version: SENTINEL_CHANGE_VERSION,
      change: 'fired',
      id,
      at,
      fact: fact as unknown as FireFact,
      ...(observed !== undefined ? { observed: decodeObserved(observed) } : {}),
    }
  }
  if (change === 'cancelled') {
    const id = value['id']
    const at = value['at']
    const reason = value['reason']
    if (typeof id !== 'string' || typeof at !== 'string'
      || (reason !== 'agent' && reason !== 'expired' && reason !== 'exhausted')) {
      throw new SentinelLogError('cancelled change must carry id, at, and a known reason')
    }
    return { version: SENTINEL_CHANGE_VERSION, change: 'cancelled', id, at, reason }
  }
  if (change === 'compacted') {
    const sub = value['subscription']
    if (!isRecord(sub)) throw new SentinelLogError('compacted change must carry a subscription object')
    const id = sub['id']
    const note = sub['note']
    const createdAt = sub['createdAt']
    if (typeof id !== 'string' || id === '') throw new SentinelLogError('subscription id must be a non-empty string')
    if (typeof note !== 'string' || note === '') throw new SentinelLogError('subscription note must be a non-empty string')
    if (typeof createdAt !== 'string') throw new SentinelLogError('subscription createdAt must be a string')
    const maxFires = sub['maxFires']
    const cooldown = sub['cooldownSeconds']
    const fireCount = sub['fireCount']
    if (typeof maxFires !== 'number' || !Number.isInteger(maxFires) || maxFires < 1) {
      throw new SentinelLogError('maxFires must be a positive integer')
    }
    if (typeof cooldown !== 'number' || !Number.isInteger(cooldown) || cooldown < 0) {
      throw new SentinelLogError('cooldownSeconds must be a non-negative integer')
    }
    if (typeof fireCount !== 'number' || !Number.isInteger(fireCount) || fireCount < 0) {
      throw new SentinelLogError('compacted fireCount must be a non-negative integer')
    }
    const expiresAt = sub['expiresAt']
    if (expiresAt !== undefined && typeof expiresAt !== 'string') {
      throw new SentinelLogError('expiresAt must be a string when present')
    }
    const lastFiredAt = sub['lastFiredAt']
    if (lastFiredAt !== undefined && typeof lastFiredAt !== 'string') {
      throw new SentinelLogError('lastFiredAt must be a string when present')
    }
    const lastKnown = sub['lastKnown']
    return {
      version: SENTINEL_CHANGE_VERSION,
      change: 'compacted',
      subscription: {
        id,
        spec: normalizeSpec(sub['spec']),
        note,
        maxFires,
        cooldownSeconds: cooldown,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        createdAt,
        fireCount,
        ...(lastFiredAt !== undefined ? { lastFiredAt } : {}),
        ...(lastKnown !== undefined ? { lastKnown: decodeObserved(lastKnown) } : {}),
      },
    }
  }
  throw new SentinelLogError(`unknown sentinel change: ${String(change)}`)
}

/** The folded live picture: active subscriptions by id. */
export interface FoldedSentinel {
  readonly active: ReadonlyMap<string, Subscription>
  /** Highest numeric suffix seen across all created ids (for allocation). */
  readonly lastOrdinal: number
}

/** Event-row shape the fold needs (structural view of a session event). */
export interface SentinelEventRow {
  readonly type: string
  readonly payload?: unknown
}

/**
 * Rebuild live subscriptions from a session event log. Corrupt rows fail the
 * fold loudly (SentinelLogError) — a durable log this plugin wrote itself is
 * a contract, not a suggestion.
 */
export function foldSentinelEvents(events: Iterable<SentinelEventRow>): FoldedSentinel {
  const active = new Map<string, Subscription>()
  let lastOrdinal = 0
  for (const event of events) {
    if (event.type !== SENTINEL_CHANGE_TYPE) continue
    const change = decodeSentinelChange(event.payload)
    if (change.change === 'created') {
      const sub = change.subscription
      active.set(sub.id, { ...sub, fireCount: 0 })
      const match = /^watch-(\d+)$/.exec(sub.id)
      if (match !== null) lastOrdinal = Math.max(lastOrdinal, Number(match[1]))
      continue
    }
    if (change.change === 'compacted') {
      const sub = change.subscription
      active.set(sub.id, { ...sub })
      const match = /^watch-(\d+)$/.exec(sub.id)
      if (match !== null) lastOrdinal = Math.max(lastOrdinal, Number(match[1]))
      continue
    }
    if (change.change === 'baseline') {
      const sub = active.get(change.id)
      if (sub === undefined) continue
      active.set(change.id, { ...sub, lastKnown: change.observed })
      continue
    }
    if (change.change === 'fired') {
      const sub = active.get(change.id)
      if (sub === undefined) continue
      const fired: Subscription = {
        ...sub,
        fireCount: sub.fireCount + 1,
        lastFiredAt: change.at,
        ...(change.observed !== undefined ? { lastKnown: change.observed } : {}),
      }
      if (fired.fireCount >= fired.maxFires) active.delete(change.id)
      else active.set(change.id, fired)
      continue
    }
    active.delete(change.id)
  }
  return { active, lastOrdinal }
}

/** Allocate the next watch id given the folded picture. */
export function allocateWatchId(folded: FoldedSentinel): string {
  return `watch-${folded.lastOrdinal + 1}`
}

/** Clip a probe snapshot into an excerpt safe to log and deliver. */
export function clipExcerpt(text: string): string {
  if (text.length <= MAX_EXCERPT_LENGTH) return text
  return `${text.slice(0, MAX_EXCERPT_LENGTH)}… (${String(text.length - MAX_EXCERPT_LENGTH)} more chars)`
}

/**
 * Render the wakeup message body: receipt, note, fact, history — everything
 * future-self needs without re-probing.
 */
export function renderWakeup(sub: Subscription, fact: FireFact): string {
  const lines = [
    `[dsh-sentinel] 订阅 ${sub.id} 触发（第 ${String(fact.fireNumber)}/${String(sub.maxFires)} 次）`,
    `监控对象: ${sub.spec.kind} · ${sub.spec.target}`,
    sub.spec.pattern !== undefined ? `匹配模式: /${sub.spec.pattern}/` : undefined,
    `变化: ${fact.summary}`,
    fact.before !== '' ? `之前:\n${fact.before}` : undefined,
    `现在:\n${fact.after}`,
    '',
    `你注册时留给自己的便签:\n${sub.note}`,
    '',
    fact.fireNumber >= sub.maxFires
      ? '这是最后一次触发，该订阅已自动结束。'
      : `剩余 ${String(sub.maxFires - fact.fireNumber)} 次触发额度；如果不再需要，用 sentinel_cancel 工具取消（id: "${sub.id}"）。`,
  ]
  return lines.filter((line): line is string => line !== undefined).join('\n')
}
