/**
 * dsh-sentinel, node half.
 *
 * Lifecycle: watching is a SERVER-lifetime concern. One SentinelRuntime owns
 * every session's subscriptions, probes all sensors on a shared heartbeat,
 * and delivers wakeups through the official followup channel — resuming the
 * session's agent via `ctx.agents.resume()` first when it is dormant.
 *
 * Durability: sentinel state lives in a plugin-owned sidecar JSONL under the
 * harness home (see ./store.ts — the host session log rejects foreign event
 * types on its cold read path, so it must stay untouched). State is always a
 * fold over that log; the fold seeds probe baselines, so changes that happen
 * while a session sleeps (or the server is down) late-fire on the next probe.
 *
 * Registered tools: sentinel_watch / sentinel_list / sentinel_cancel.
 * Read-only routes: /plugins/dsh-sentinel/state (browser dock and sidebar
 * branch render it) and /plugins/dsh-sentinel/dashboard (server-global watch
 * table). Push route: POST /plugins/dsh-sentinel/hook?id=watch-N (webhooks).
 * The routes mount through dynamic `ctx.inject(['webServer'])`, so headless
 * profiles without a webServer service still load the runtime and tools.
 */
import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  allocateWatchId,
  clipExcerpt,
  foldSentinelEvents,
  MAX_NOTE_LENGTH,
  MAX_SUBSCRIPTIONS_PER_AGENT,
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
  normalizeSpec,
  renderWakeup,
  SENTINEL_CHANGE_TYPE,
  SENTINEL_CHANGE_VERSION,
  SentinelLogError,
  type FireFact,
  type FoldedSentinel,
  type KnownSnapshot,
  type SentinelChange,
  type Subscription,
} from './domain.ts'
import { probe, shouldFire } from './sensors.ts'
import { SentinelStore, type FoldableRow } from './store.ts'

export const name = 'dsh-sentinel'
// webServer is deliberately absent: headless profiles have no web server, and
// the routes below mount through ctx.inject(['webServer']) instead.
export const inject = ['agents', 'agentDefaultModel', 'tools']

const PLUGIN_ID = 'dsh-sentinel'
export const STATE_PATH = `/plugins/${PLUGIN_ID}/state`
export const HOOK_PATH = `/plugins/${PLUGIN_ID}/hook`
export const DASHBOARD_PATH = `/plugins/${PLUGIN_ID}/dashboard`
const HEARTBEAT_MS = 5000
const PUSH_DEBOUNCE_MS = 250
const MAX_PENDING_WAKEUPS = 8
/** fsWatch arm failures back off this long before retrying (heartbeat polling covers the gap). */
const FILE_WATCH_RETRY_MS = 60_000
/** Compact the sidecar at boot when rows exceed active subscriptions by this margin. */
const COMPACTION_MARGIN = 32

/** Sidecar log location: `$DSH_HOME/sentinel.jsonl` (the settings-file convention). */
export function storePath(): string {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return join(home, 'sentinel.jsonl')
}

/** Structural view of the host Agent surface this plugin touches. */
interface AgentLike {
  readonly id: string
  readonly status: string
  followup(message: unknown): void
  readonly ctx: ContextLike
}

interface ContextLike {
  effect(body: () => (() => void | Promise<void>) | Promise<() => void>, label?: string): () => void | Promise<void>
  on(event: string, callback: (...args: never[]) => void): () => void
  /** Cordis dynamic injection: runs the callback once every listed service is
   * published; never runs (and does not block activation) when one is absent. */
  inject(deps: string[], callback: (ctx: ContextLike) => void): () => void
  readonly logger: { warn(message: string): void }
  readonly agents: {
    roots(): AgentLike[]
    get(id: string): AgentLike | undefined
    resume(options: { resumeSessionId: string; agentOptions?: Record<string, unknown> }): Promise<{ agent: AgentLike; dispose(): void | Promise<void> }>
  }
  readonly agentDefaultModel: {
    currentSelection(): { provider: string; model: string }
  }
  readonly tools: { register(definition: unknown): () => void }
  readonly webServer?: {
    register(route: {
      kind: 'exact'
      path: string
      handler: (req: {
        url?: string
        method?: string
        on(event: 'data' | 'end', callback: (chunk?: unknown) => void): void
      }, res: {
        writeHead(status: number, headers: Record<string, string>): void
        end(body: string): void
      }) => void | Promise<void>
    }): () => void
  }
}

/** Per-subscription probe bookkeeping (in-memory; persisted baselines re-seed it). */
interface ProbeState {
  lastSnapshot?: string
  lastState?: string
  lastProbeAt?: number
  nextDueAt: number
  probing: boolean
}

/** Ring entry for the transparency route (recent fires). */
interface FireRecord {
  readonly id: string
  readonly at: string
  readonly summary: string
}

/** All sentinel state for one session; lives as long as the server, not the agent. */
class SessionWatch {
  folded: FoldedSentinel = { active: new Map(), lastOrdinal: 0 }
  rows: FoldableRow[] = []
  readonly probes = new Map<string, ProbeState>()
  readonly watchers = new Map<string, { watcher: FSWatcher; mode: 'direct' | 'parent' }>()
  /** Last fsWatch arm failure per subscription; arms back off for FILE_WATCH_RETRY_MS. */
  readonly watchFailures = new Map<string, number>()
  readonly pushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly recentFires: FireRecord[] = []
  readonly pendingWakeups: string[] = []

  constructor(readonly sessionId: string) {}

  closeSensors(): void {
    for (const entry of this.watchers.values()) entry.watcher.close()
    this.watchers.clear()
    for (const timer of this.pushTimers.values()) clearTimeout(timer)
    this.pushTimers.clear()
  }
}

/**
 * The server-lifetime watcher runtime: owns every SessionWatch, one shared
 * heartbeat, the durable sidecar log, and the wakeup channel (resuming
 * dormant sessions on fire).
 */
class SentinelRuntime {
  private readonly watches = new Map<string, SessionWatch>()
  private readonly resumes = new Map<string, Promise<AgentLike>>()
  private readonly handles: Array<{ dispose(): void | Promise<void> }> = []
  private timer: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(
    private readonly ctx: ContextLike,
    private readonly store: SentinelStore,
  ) {}

  start(): void {
    this.timer = setInterval(() => { void this.drive() }, HEARTBEAT_MS)
    // Headless profiles exit when the prompt completes: the heartbeat must not
    // hold the event loop open there. Web mode stays up on the server's own
    // handles; subscriptions survive either way through the sidecar log.
    this.timer.unref()
    void this.loadPersisted()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    for (const watch of this.watches.values()) watch.closeSensors()
    this.watches.clear()
    for (const handle of this.handles.splice(0, this.handles.length)) {
      void Promise.resolve().then(() => handle.dispose()).catch(() => {})
    }
  }

  /** Boot: fold the sidecar log and arm every session that still has active watches. */
  private async loadPersisted(): Promise<void> {
    let grouped: Map<string, FoldableRow[]>
    try {
      grouped = await this.store.load()
    } catch (error: unknown) {
      this.warn(`sidecar log load failed: ${describe(error)}`)
      return
    }
    if (this.disposed) return
    let totalRows = 0
    for (const [sessionId, rows] of grouped) {
      totalRows += rows.length
      const watch = this.watchOf(sessionId)
      watch.rows = rows
      this.refold(watch)
      if (watch.folded.active.size === 0) {
        watch.closeSensors()
        this.watches.delete(sessionId)
      }
    }
    this.compact(totalRows)
    void this.drive()
  }

  /**
   * Rewrite a history-heavy sidecar as one 'compacted' row per active
   * subscription (fire budget and last observation intact). Fire-and-forget:
   * later appends ride the store chain, so they land after the rewrite.
   */
  private compact(totalRows: number): void {
    let activeCount = 0
    for (const watch of this.watches.values()) activeCount += watch.folded.active.size
    if (totalRows <= activeCount * 4 + COMPACTION_MARGIN) return
    const lines: string[] = []
    for (const watch of this.watches.values()) {
      for (const sub of watch.folded.active.values()) {
        lines.push(JSON.stringify({
          v: SENTINEL_CHANGE_VERSION,
          sessionId: watch.sessionId,
          change: { version: SENTINEL_CHANGE_VERSION, change: 'compacted', subscription: sub },
        }))
      }
    }
    void this.store.replaceAll(lines).then(
      () => { this.warn(`sidecar compacted: ${String(totalRows)} rows -> ${String(lines.length)}`) },
      (error: unknown) => { this.warn(`sidecar compaction failed (will retry next boot): ${describe(error)}`) },
    )
  }

  /** The session's watch bucket, created on demand. */
  watchOf(sessionId: string): SessionWatch {
    let watch = this.watches.get(sessionId)
    if (watch === undefined) {
      watch = new SessionWatch(sessionId)
      this.watches.set(sessionId, watch)
    }
    return watch
  }

  /** All watches, for the state route. */
  view(): ReadonlyMap<string, SessionWatch> {
    return this.watches
  }

  findByWatchId(id: string): SessionWatch | undefined {
    for (const watch of this.watches.values()) {
      if (watch.folded.active.has(id)) return watch
    }
    return undefined
  }

  private warn(message: string): void {
    this.ctx.logger.warn(`${PLUGIN_ID}: ${message}`)
  }

  /** Durably append one change, then refold that session's picture. */
  private async commit(watch: SessionWatch, change: SentinelChange): Promise<void> {
    await this.store.append(watch.sessionId, change)
    watch.rows.push({ type: SENTINEL_CHANGE_TYPE, payload: change })
    this.refold(watch)
  }

  private refold(watch: SessionWatch): void {
    try {
      watch.folded = foldSentinelEvents(watch.rows)
    } catch (error: unknown) {
      // A corrupt sentinel row must not take the session down; surface and continue empty.
      this.warn(`fold failed for session "${watch.sessionId}": ${describe(error)}`)
      watch.folded = { active: new Map(), lastOrdinal: 0 }
    }
    for (const id of [...watch.probes.keys()]) {
      if (!watch.folded.active.has(id)) watch.probes.delete(id)
    }
    for (const [id, entry] of [...watch.watchers]) {
      if (!watch.folded.active.has(id)) {
        entry.watcher.close()
        watch.watchers.delete(id)
      }
    }
    for (const sub of watch.folded.active.values()) {
      if (!watch.probes.has(sub.id)) {
        watch.probes.set(sub.id, {
          nextDueAt: Date.now(),
          probing: false,
          ...(sub.lastKnown !== undefined
            ? { lastSnapshot: sub.lastKnown.snapshot, lastState: sub.lastKnown.state }
            : {}),
        })
      }
      if (sub.spec.kind === 'file') this.armFileWatch(watch, sub.id, sub.spec.target)
      if (sub.spec.kind === 'webhook') {
        const state = watch.probes.get(sub.id)
        if (state !== undefined && state.lastState === undefined) state.lastState = 'awaiting push'
      }
    }
  }

  /**
   * The session's live agent, resuming it when dormant. Concurrent callers
   * share one resume (the api-remotes agent-lookup dedupe pattern).
   */
  private async ensureAgent(sessionId: string): Promise<AgentLike> {
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) return live
    let pending = this.resumes.get(sessionId)
    if (pending === undefined) {
      pending = (async () => {
        try {
          const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
          const handle = await this.ctx.agents.resume({
            resumeSessionId: sessionId,
            agentOptions: { provider, model },
          })
          this.handles.push(handle)
          return handle.agent
        } finally {
          this.resumes.delete(sessionId)
        }
      })()
      this.resumes.set(sessionId, pending)
    }
    return pending
  }

  async create(sessionId: string, spec: unknown, note: string, maxFires: number, cooldownSeconds: number, expiresInSeconds?: number): Promise<Subscription> {
    const normalized = normalizeSpec(spec)
    const watch = this.watchOf(sessionId)
    if (watch.folded.active.size >= MAX_SUBSCRIPTIONS_PER_AGENT) {
      throw new SentinelLogError(`subscription limit reached (${String(MAX_SUBSCRIPTIONS_PER_AGENT)}); cancel one first`)
    }
    const id = allocateWatchId(watch.folded)
    const createdAt = new Date().toISOString()
    const subscription = {
      id,
      spec: normalized,
      note,
      maxFires,
      cooldownSeconds,
      ...(expiresInSeconds !== undefined
        ? { expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString() }
        : {}),
      createdAt,
    }
    await this.commit(watch, {
      version: SENTINEL_CHANGE_VERSION,
      change: 'created',
      subscription,
    })
    void this.drive()
    return { ...subscription, fireCount: 0 }
  }

  /** Cancel durably — a sidecar write, no session involvement. */
  async cancel(sessionId: string, id: string, reason: 'agent' | 'expired' | 'exhausted'): Promise<boolean> {
    const watch = this.watches.get(sessionId)
    if (watch === undefined || !watch.folded.active.has(id)) return false
    await this.commit(watch, {
      version: SENTINEL_CHANGE_VERSION,
      change: 'cancelled',
      id,
      at: new Date().toISOString(),
      reason,
    })
    return true
  }

  private async drive(): Promise<void> {
    if (this.disposed) return
    for (const watch of [...this.watches.values()]) {
      const now = Date.now()
      for (const sub of [...watch.folded.active.values()]) {
        if (sub.expiresAt !== undefined && Date.parse(sub.expiresAt) <= now) {
          try {
            await this.cancel(watch.sessionId, sub.id, 'expired')
          } catch (error: unknown) {
            this.warn(`expiry cancel failed for ${sub.id}: ${describe(error)}`)
          }
          continue
        }
        if (sub.spec.kind === 'webhook') continue
        const state = watch.probes.get(sub.id)
        if (state === undefined || state.probing || state.nextDueAt > now) continue
        if (sub.lastFiredAt !== undefined
          && now - Date.parse(sub.lastFiredAt) < sub.cooldownSeconds * 1000) continue
        state.probing = true
        try {
          await this.probeOne(watch, sub, state)
        } finally {
          state.probing = false
          state.lastProbeAt = Date.now()
          state.nextDueAt = Date.now() + sub.spec.intervalSeconds * 1000
        }
      }
      this.flushWakeups(watch)
    }
  }

  /**
   * Push channel for file watches: inotify on the file itself, or on its
   * parent directory while the file does not exist yet. Watch events only
   * accelerate the probe — the fire decision still runs through the same
   * snapshot diff, so duplicate or spurious events cannot double-fire.
   */
  private armFileWatch(watch: SessionWatch, id: string, target: string): void {
    if (watch.watchers.has(id) || this.disposed) return
    const failedAt = watch.watchFailures.get(id)
    if (failedAt !== undefined && Date.now() - failedAt < FILE_WATCH_RETRY_MS) return
    const arm = (path: string, mode: 'direct' | 'parent'): void => {
      try {
        const watcher = fsWatch(path, { persistent: false }, (_event, fileName) => {
          if (mode === 'parent' && fileName !== null && fileName !== basename(target)) return
          this.schedulePushProbe(watch, id)
        })
        watcher.on('error', () => {
          watcher.close()
          watch.watchers.delete(id)
          watch.watchFailures.set(id, Date.now())
        })
        watch.watchers.set(id, { watcher, mode })
        watch.watchFailures.delete(id)
      } catch {
        // Back off and fall back to heartbeat polling; the reconcile loop still covers this watch.
        watch.watchFailures.set(id, Date.now())
      }
    }
    void stat(target).then(
      () => { arm(target, 'direct') },
      () => { arm(dirname(target), 'parent') },
    )
  }

  /** Debounced fast-path probe for one subscription (bursty fs events collapse to one). */
  private schedulePushProbe(watch: SessionWatch, id: string): void {
    if (this.disposed) return
    const existing = watch.pushTimers.get(id)
    if (existing !== undefined) clearTimeout(existing)
    watch.pushTimers.set(id, setTimeout(() => {
      watch.pushTimers.delete(id)
      const state = watch.probes.get(id)
      if (state !== undefined) state.nextDueAt = 0
      void this.drive().then(() => {
        // A parent-mode watcher saw the file get born: upgrade to a direct watch.
        const entry = watch.watchers.get(id)
        const sub = watch.folded.active.get(id)
        if (entry?.mode === 'parent' && sub !== undefined) {
          void stat(sub.spec.target).then(() => {
            entry.watcher.close()
            watch.watchers.delete(id)
            this.armFileWatch(watch, id, sub.spec.target)
          }, () => {})
        }
      })
    }, PUSH_DEBOUNCE_MS))
  }

  /**
   * External push entry: fire the webhook subscription with the posted
   * payload, honoring pattern and cooldown exactly like a probe transition.
   */
  async handleWebhook(watch: SessionWatch, id: string, payload: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const sub = watch.folded.active.get(id)
    if (sub === undefined || sub.spec.kind !== 'webhook') {
      return { status: 404, body: { fired: false, reason: 'no such webhook watch' } }
    }
    if (sub.spec.pattern !== undefined && !new RegExp(sub.spec.pattern, 'm').test(payload)) {
      return { status: 202, body: { fired: false, reason: 'payload does not match pattern' } }
    }
    if (sub.lastFiredAt !== undefined
      && Date.now() - Date.parse(sub.lastFiredAt) < sub.cooldownSeconds * 1000) {
      return { status: 202, body: { fired: false, reason: 'cooldown' } }
    }
    try {
      await this.fireSubscription(watch, sub, {
        fireNumber: sub.fireCount + 1,
        summary: '外部推送到达（webhook）',
        before: '',
        after: clipExcerpt(payload === '' ? '<empty payload>' : payload),
        probeMs: 0,
      })
    } catch (error: unknown) {
      this.warn(`webhook fire failed for ${id}: ${describe(error)}`)
      return { status: 503, body: { fired: false, reason: 'delivery failed, retry' } }
    }
    void this.deliver(watch)
    return { status: 200, body: { fired: true, id } }
  }

  /** The single durable fire path: log the change, remember it, queue the wakeup. */
  private async fireSubscription(watch: SessionWatch, sub: Subscription, fact: FireFact, observed?: KnownSnapshot): Promise<void> {
    const at = new Date().toISOString()
    await this.commit(watch, {
      version: SENTINEL_CHANGE_VERSION,
      change: 'fired',
      id: sub.id,
      at,
      fact,
      ...(observed !== undefined ? { observed } : {}),
    })
    watch.recentFires.unshift({ id: sub.id, at, summary: fact.summary })
    if (watch.recentFires.length > 20) watch.recentFires.pop()
    watch.pendingWakeups.push(renderWakeup(sub, fact))
    if (watch.pendingWakeups.length > MAX_PENDING_WAKEUPS) watch.pendingWakeups.shift()
  }

  private async probeOne(watch: SessionWatch, sub: Subscription, state: ProbeState): Promise<void> {
    const startedAt = Date.now()
    const result = await probe(sub.spec)
    if (this.disposed || !watch.folded.active.has(sub.id)) return
    const decision = shouldFire(sub.spec.pattern, state.lastSnapshot, result.snapshot)
    const previousSnapshot = state.lastSnapshot
    state.lastSnapshot = result.snapshot
    state.lastState = result.state
    if (!decision.fire) {
      // First observation of this subscription's life: persist it so a later
      // server or session restart compares against this baseline instead of
      // silently re-arming.
      if (previousSnapshot === undefined && sub.lastKnown === undefined) {
        try {
          await this.commit(watch, {
            version: SENTINEL_CHANGE_VERSION,
            change: 'baseline',
            id: sub.id,
            at: new Date().toISOString(),
            observed: { state: result.state, snapshot: result.snapshot },
          })
        } catch (error: unknown) {
          this.warn(`baseline write failed for ${sub.id}: ${describe(error)}`)
        }
      }
      return
    }
    try {
      await this.fireSubscription(watch, sub, {
        fireNumber: sub.fireCount + 1,
        summary: `${decision.summary}（状态: ${result.state}）`,
        before: clipExcerpt(previousSnapshot ?? ''),
        after: clipExcerpt(result.snapshot),
        probeMs: Date.now() - startedAt,
      }, { state: result.state, snapshot: result.snapshot })
    } catch (error: unknown) {
      // Keep the pre-fire baseline: the same transition re-fires next heartbeat.
      state.lastSnapshot = previousSnapshot
      this.warn(`fire failed for ${sub.id} (will retry): ${describe(error)}`)
    }
  }

  /**
   * Deliver queued wakeups. A live idle agent gets them immediately; a
   * dormant session is resumed first — that resurrection is the plugin's
   * whole reason to exist.
   */
  private async deliver(watch: SessionWatch): Promise<void> {
    if (watch.pendingWakeups.length === 0) return
    let agent: AgentLike
    try {
      agent = await this.ensureAgent(watch.sessionId)
    } catch (error: unknown) {
      this.warn(`could not resume session "${watch.sessionId}" for wakeup (will retry): ${describe(error)}`)
      return
    }
    if (agent.status !== 'idle' || watch.pendingWakeups.length === 0) return
    const batch = watch.pendingWakeups.splice(0, watch.pendingWakeups.length)
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: batch.join('\n\n---\n\n') }],
        source: { kind: 'plugin', plugin: PLUGIN_ID },
      }))
    } catch (error: unknown) {
      this.warn(`wakeup delivery failed for session "${watch.sessionId}": ${describe(error)}`)
      watch.pendingWakeups.unshift(...batch)
    }
  }

  /** Idle-edge and heartbeat entry: fire-and-forget delivery. */
  flushWakeups(watch: SessionWatch): void {
    if (watch.pendingWakeups.length === 0) return
    void this.deliver(watch)
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const WATCH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    target: { type: 'string', required: true },
    intervalSeconds: { type: 'integer', required: true },
    maxFires: { type: 'integer', required: true },
    note: { type: 'string', required: true },
    hookPath: { type: 'string' },
  },
} as const

const LIST_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    subscriptions: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          target: { type: 'string', required: true },
          pattern: { type: 'string' },
          intervalSeconds: { type: 'integer', required: true },
          fireCount: { type: 'integer', required: true },
          maxFires: { type: 'integer', required: true },
          note: { type: 'string', required: true },
          lastState: { type: 'string' },
        },
      },
    },
  },
} as const

const CANCEL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cancelled: { type: 'boolean', required: true },
    id: { type: 'string', required: true },
  },
} as const

function textBlock(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }]
}

function registerSentinelTools(runtime: SentinelRuntime, toolCtx: ContextLike, agent: AgentLike): Array<() => void> {
  const disposers: Array<() => void> = []

  disposers.push(toolCtx.tools.register(defineTool({
    name: 'sentinel_watch',
    description: [
      'Register a durable condition watch. The sentinel watches on the server side — even while this session',
      ' is closed or the agent is asleep — and wakes you with a structured report when the condition',
      ' transitions (a dormant session is resumed automatically), so do NOT poll or sleep for it yourself.',
      ' Watches survive process restarts. Kinds: "file" (path snapshot; inotify push, reacts in under a',
      ' second), "command" (read-only shell line probed on an interval; fires on output/exit change),',
      ' "http" (URL status+body probed on an interval), "process" (pgrep pattern probed on an interval),',
      ' "webhook" (pure push: returns a hook URL, any external system can POST to it to wake you —',
      ' put a curl into a CI job, git hook, or another machine\'s script). With "pattern", probe kinds fire',
      ' on the no-match→match edge of that regex and webhooks fire only when the payload matches;',
      ' without it, probe kinds fire on any snapshot change after the baseline and webhooks fire on any POST.',
    ].join(''),
    parameters: {
      kind: {
        type: 'string',
        required: true,
        enum: ['file', 'command', 'http', 'process', 'webhook'],
        description: 'Sensor engine: probing (file/command/http/process) or pure push (webhook).',
      },
      target: {
        type: 'string',
        required: true,
        description: 'file: absolute path; command: read-only shell line; http: URL; process: pgrep -f pattern; webhook: short label naming the expected caller.',
      },
      pattern: {
        type: 'string',
        description: 'Optional regex; probe kinds fire on its no-match→match transition, webhooks only accept matching payloads.',
      },
      interval_seconds: {
        type: 'number',
        description: `Probe interval in seconds (${String(MIN_INTERVAL_SECONDS)}–${String(MAX_INTERVAL_SECONDS)}, default 30; ignored for webhook and accelerated by push for file).`,
      },
      note: {
        type: 'string',
        required: true,
        description: 'Message to your future self: why this watch exists and what to do when it fires. Delivered verbatim with every wakeup.',
      },
      max_fires: {
        type: 'number',
        description: 'Auto-cancel after this many fires (default 1: one-shot).',
      },
      cooldown_seconds: {
        type: 'number',
        description: 'Silence window after each fire (default 60).',
      },
      expires_in_seconds: {
        type: 'number',
        description: 'Optional lifetime; the watch cancels itself when this elapses without firing.',
      },
    },
    output: {
      schema: WATCH_OUTPUT_SCHEMA,
      render: (_args: unknown, value: { id: string; kind: string; target: string; intervalSeconds: number; hookPath?: string }) =>
        textBlock(value.hookPath !== undefined
          ? `哨兵订阅 ${value.id} 已注册: webhook · ${value.target}\n推送地址: POST ${value.hookPath}`
          : `哨兵订阅 ${value.id} 已注册: ${value.kind} · ${value.target}（每 ${String(value.intervalSeconds)}s 探测${value.kind === 'file' ? '，文件变化即时推送' : ''}；会话休眠时由服务端值守）`),
    },
    async execute(args: {
      kind: string
      target: string
      pattern?: string
      interval_seconds?: number
      note: string
      max_fires?: number
      cooldown_seconds?: number
      expires_in_seconds?: number
    }) {
      const note = args.note.trim()
      if (note === '') throw new SentinelLogError('note must not be empty — tell your future self why this watch exists')
      if (note.length > MAX_NOTE_LENGTH) throw new SentinelLogError(`note too long (${String(note.length)} > ${String(MAX_NOTE_LENGTH)})`)
      const maxFires = args.max_fires !== undefined ? Math.max(1, Math.round(args.max_fires)) : 1
      const cooldown = args.cooldown_seconds !== undefined ? Math.max(0, Math.round(args.cooldown_seconds)) : 60
      const expires = args.expires_in_seconds !== undefined ? Math.max(HEARTBEAT_MS / 1000, Math.round(args.expires_in_seconds)) : undefined
      const subscription = await runtime.create(
        agent.id,
        {
          kind: args.kind,
          target: args.target,
          ...(args.pattern !== undefined ? { pattern: args.pattern } : {}),
          intervalSeconds: args.interval_seconds ?? 30,
        },
        note,
        maxFires,
        cooldown,
        expires,
      )
      return {
        id: subscription.id,
        kind: subscription.spec.kind,
        target: subscription.spec.target,
        intervalSeconds: subscription.spec.intervalSeconds,
        maxFires: subscription.maxFires,
        note: subscription.note,
        ...(subscription.spec.kind === 'webhook'
          ? { hookPath: `${HOOK_PATH}?id=${subscription.id}` }
          : {}),
      }
    },
  })))

  disposers.push(toolCtx.tools.register(defineTool({
    name: 'sentinel_list',
    description: 'List this session\'s active sentinel watches with their live probe state.',
    parameters: {},
    output: {
      schema: LIST_OUTPUT_SCHEMA,
      render: (_args: unknown, value: { subscriptions: Array<{ id: string; kind: string; target: string; fireCount: number; maxFires: number; lastState?: string }> }) =>
        textBlock(value.subscriptions.length === 0
          ? '没有活跃的哨兵订阅。'
          : value.subscriptions.map(row =>
            `${row.id}: ${row.kind} · ${row.target} [${row.lastState ?? '未探测'}] 触发 ${String(row.fireCount)}/${String(row.maxFires)}`).join('\n')),
    },
    async execute() {
      const watch = runtime.watchOf(agent.id)
      return {
        subscriptions: [...watch.folded.active.values()].map(sub => ({
          id: sub.id,
          kind: sub.spec.kind,
          target: sub.spec.target,
          ...(sub.spec.pattern !== undefined ? { pattern: sub.spec.pattern } : {}),
          intervalSeconds: sub.spec.intervalSeconds,
          fireCount: sub.fireCount,
          maxFires: sub.maxFires,
          note: sub.note,
          ...(watch.probes.get(sub.id)?.lastState !== undefined ? { lastState: watch.probes.get(sub.id)?.lastState } : {}),
        })),
      }
    },
  })))

  disposers.push(toolCtx.tools.register(defineTool({
    name: 'sentinel_cancel',
    description: 'Cancel one sentinel watch by id.',
    parameters: {
      id: { type: 'string', required: true, description: 'The watch id (e.g. "watch-3").' },
    },
    output: {
      schema: CANCEL_OUTPUT_SCHEMA,
      render: (_args: unknown, value: { cancelled: boolean; id: string }) =>
        textBlock(value.cancelled ? `订阅 ${value.id} 已取消。` : `没有名为 ${value.id} 的活跃订阅。`),
    },
    async execute(args: { id: string }) {
      return { cancelled: await runtime.cancel(agent.id, args.id, 'agent'), id: args.id }
    },
  })))

  return disposers
}

/** Wire shape of one watch row on the transparency routes. */
export interface WatchRow {
  sessionId: string
  live: boolean
  id: string
  kind: string
  target: string
  pattern?: string
  intervalSeconds: number
  note: string
  fireCount: number
  maxFires: number
  createdAt: string
  expiresAt?: string
  lastState?: string
  lastProbeAt?: number
  nextDueAt?: number
}

/**
 * Flatten the runtime's active subscriptions into wire rows.
 * @param runtime - the server-lifetime sentinel runtime.
 * @param ctx - host surface (agent liveness lookup).
 * @param sessionId - empty for every session, or one session id to filter.
 * @returns the watch rows (fires stay with the state route's own collection).
 */
function collectWatchRows(runtime: SentinelRuntime, ctx: ContextLike, sessionId: string): WatchRow[] {
  const rows: WatchRow[] = []
  for (const [id, watch] of runtime.view()) {
    if (sessionId !== '' && id !== sessionId) continue
    const live = ctx.agents.get(id) !== undefined
    for (const sub of watch.folded.active.values()) {
      const probeState = watch.probes.get(sub.id)
      rows.push({
        sessionId: id,
        live,
        id: sub.id,
        kind: sub.spec.kind,
        target: sub.spec.target,
        pattern: sub.spec.pattern,
        intervalSeconds: sub.spec.intervalSeconds,
        note: sub.note,
        fireCount: sub.fireCount,
        maxFires: sub.maxFires,
        createdAt: sub.createdAt,
        expiresAt: sub.expiresAt,
        lastState: probeState?.lastState,
        lastProbeAt: probeState?.lastProbeAt,
        nextDueAt: probeState?.nextDueAt,
      })
    }
  }
  return rows
}

/** Escape a user-controlled string for the dashboard HTML. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

/** One dashboard table row (server render and the client refresh share it). */
function watchRowHtml(row: WatchRow): string {
  const session = `${escapeHtml(row.sessionId.slice(0, 16))}… <small>${row.live ? '活跃' : '休眠'}</small>`
  const pattern = row.pattern !== undefined ? `<code>/${escapeHtml(row.pattern)}/</code>` : '—'
  const lastState = row.lastState !== undefined ? escapeHtml(row.lastState) : '探测中'
  const next = row.kind === 'webhook'
    ? '即时推送'
    : row.nextDueAt !== undefined ? `${String(Math.max(0, Math.ceil((row.nextDueAt - Date.now()) / 1000)))}s` : '…'
  return `<tr><td>${session}</td><td>${escapeHtml(row.id)}</td><td>${escapeHtml(row.kind)}</td>`
    + `<td class="target" title="${escapeHtml(row.note)}">${escapeHtml(row.target)}</td><td>${pattern}</td>`
    + `<td>${String(row.fireCount)}/${String(row.maxFires)}</td><td>${lastState}</td><td>${next}</td></tr>`
}

/**
 * The server-global watch table page; the client script re-renders it from
 * the state route. Exported for the escaping tests.
 * @param rows - the watch rows to server-render into the initial table body.
 * @returns the complete HTML document.
 */
export function dashboardHtml(rows: readonly WatchRow[]): string {
  const body = rows.length === 0
    ? '<tr><td colspan="8" class="empty">当前没有活跃的监控。</td></tr>'
    : rows.map(watchRowHtml).join('')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sentinel 全局总览</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; color: #1f2329; }
  h1 { font-size: 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border-bottom: 1px solid #e5e6eb; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { color: #86909c; font-weight: 500; white-space: nowrap; }
  td.target { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.empty { color: #86909c; text-align: center; padding: 24px; }
  code { background: #f2f3f5; padding: 1px 4px; border-radius: 4px; }
  small { color: #86909c; }
</style>
</head>
<body>
<h1>👁 Sentinel 全局总览 <small id="meta"></small></h1>
<table>
<thead><tr><th>会话</th><th>监控</th><th>传感器</th><th>目标</th><th>模式</th><th>触发</th><th>最近状态</th><th>下次探测</th></tr></thead>
<tbody id="rows">${body}</tbody>
</table>
<script>
const ROWS = document.getElementById('rows')
const META = document.getElementById('meta')
const render = ${watchRowHtml.toString()}
const escapeHtml = ${escapeHtml.toString()}
// watchRowHtml's body references Date.now through the next-probe cell; keep it.
const refresh = async () => {
  try {
    const res = await fetch(${JSON.stringify(STATE_PATH)}, { headers: { accept: 'application/json' } })
    if (!res.ok) return
    const data = await res.json()
    const watches = Array.isArray(data.watches) ? data.watches : []
    ROWS.innerHTML = watches.length === 0
      ? '<tr><td colspan="8" class="empty">当前没有活跃的监控。</td></tr>'
      : watches.map(render).join('')
    META.textContent = '· ' + String(watches.length) + ' 个监控 · ' + new Date().toLocaleTimeString()
  } catch {}
}
refresh()
setInterval(refresh, 3000)
</script>
</body>
</html>
`
}

type WebServerLike = NonNullable<ContextLike['webServer']>

/**
 * HTTP surface: state JSON (dock / branch / tab poll it), dashboard table,
 * webhook push. Mounted only when the host publishes webServer; headless
 * profiles run the runtime and tools without it.
 */
function registerRoutes(runtime: SentinelRuntime, ctx: ContextLike, webServer: WebServerLike): () => void {
  const stopRoute = webServer.register({
    kind: 'exact',
    path: STATE_PATH,
    handler: (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const rows: unknown[] = collectWatchRows(runtime, ctx, sessionId)
        const fires: unknown[] = []
        for (const [id, watch] of runtime.view()) {
          if (sessionId !== '' && id !== sessionId) continue
          fires.push(...watch.recentFires.map(fire => ({ sessionId: id, ...fire })))
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ watches: rows, recentFires: fires }))
      } catch (error: unknown) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: describe(error) }))
      }
    },
  })

  const stopDashboard = webServer.register({
    kind: 'exact',
    path: DASHBOARD_PATH,
    handler: (_req, res) => {
      try {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(dashboardHtml(collectWatchRows(runtime, ctx, '')))
      } catch (error: unknown) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(describe(error))
      }
    },
  })

  const stopHook = webServer.register({
    kind: 'exact',
    path: HOOK_PATH,
    handler: (req, res) => {
      const respond = (status: number, body: Record<string, unknown>): void => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      }
      if ((req.method ?? 'GET') !== 'POST') {
        respond(405, { fired: false, reason: 'POST only' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const id = url.searchParams.get('id') ?? ''
      let payload = ''
      req.on('data', chunk => {
        if (payload.length < 65_536) payload += String(chunk)
      })
      req.on('end', () => {
        const watch = runtime.findByWatchId(id)
        if (watch === undefined) {
          respond(404, { fired: false, reason: 'no such webhook watch' })
          return
        }
        void runtime.handleWebhook(watch, id, payload).then(
          outcome => { respond(outcome.status, outcome.body) },
          (error: unknown) => { respond(500, { fired: false, reason: describe(error) }) },
        )
      })
    },
  })

  return () => {
    stopRoute()
    stopDashboard()
    stopHook()
  }
}

export function apply(ctx: ContextLike): void {
  ctx.effect(() => {
    const runtime = new SentinelRuntime(ctx, new SentinelStore(storePath()))
    let stopping = false

    // Routes are web-profile-only: dynamic injection keeps headless profiles
    // (no webServer service) from stalling on a pending dependency.
    const stopRoutes = ctx.inject(['webServer'], (sctx) => {
      sctx.effect(() => {
        const webServer = sctx.webServer
        return webServer === undefined ? () => {} : registerRoutes(runtime, ctx, webServer)
      }, `${PLUGIN_ID}.routes()`)
    })

    const attached = new WeakSet<AgentLike>()
    const stopCreated = ctx.on('agent/created', (...args: never[]) => {
      const { agent } = (args[0] as unknown as { agent: AgentLike })
      if (stopping || attached.has(agent) || !ctx.agents.roots().includes(agent)) return
      attached.add(agent)
      const watch = runtime.watchOf(agent.id)
      agent.ctx.effect(() => {
        const disposers = registerSentinelTools(runtime, agent.ctx, agent)
        const stopStatus = agent.ctx.on('agent/status', (...statusArgs: never[]) => {
          const { status } = (statusArgs[0] as unknown as { status: string })
          if (status === 'idle') runtime.flushWakeups(watch)
        })
        return () => {
          stopStatus()
          for (const dispose of disposers) dispose()
        }
      }, `${PLUGIN_ID}.channel()`)
    })

    runtime.start()

    return () => {
      stopping = true
      stopRoutes()
      stopCreated()
      runtime.dispose()
    }
  }, `${PLUGIN_ID}.lifecycle()`)
}
