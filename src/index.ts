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
 *
 * Durability: a duty lease (`$DSH_HOME/sentinel.lease`) keeps one probing
 * owner per harness home — a second process stays passive, adopts nothing,
 * and takes over within one lease TTL of the owner dying; the owner re-reads
 * the sidecar each heartbeat so passive-created watches join the fold.
 * Delivery is at-least-once: fires carry a `delivered` watermark, and a boot
 * requeues everything logged past it. Fires optionally fan out to an external
 * notify webhook (at-most-once, never blocks wakeup delivery).
 */
import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  allocateWatchId,
  clipExcerpt,
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_INTERVAL_SECONDS,
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
import { formatFireSummary, localizeState, resolveLocale, translate, type FireMessage, type Locale } from './locale.ts'
import { dashboardHtml } from './dashboard.ts'
export { dashboardHtml } from './dashboard.ts'
// Preserve the public boolean-based helper while sharing presentation logic with the client.
export { localizeState } from './dashboard.ts'

// DSH 0.1.7 removed the shared catch-all `plugin` message-source kind: every
// producer now declares its own `kind` by merging into `MessageSourceMap`.
// Declaring ours here compiles against both the 0.1.5 and 0.1.7 type surfaces
// (the interface exists in both), so the wakeup path needs no version split.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A sentinel watch fire delivered as a user-role wakeup. */
    sentinel: { kind: 'sentinel' }
  }
}

export const name = 'dsh-sentinel'
// webServer is deliberately absent: headless profiles have no web server, and
// the routes below mount through ctx.inject(['webServer']) instead.
export const inject = ['agents', 'agentDefaultModel', 'tools']

/**
 * Deployment-tunable knobs (the no-hardcoded-parameters convention): every
 * field must be changeable from the profile's cordis.patch.yml without
 * touching code. DEFAULT_CONFIG is the single source the schema defaults cite.
 */
export interface Config {
  /** Server-generated tool receipts, wakeups and notifications; UI uses the host locale. */
  locale?: Locale
  /** Heartbeat interval driving all probe rounds (ms). */
  heartbeatMs: number
  /** Upper bound on concurrently in-flight probes per heartbeat round. */
  probeConcurrency: number
  /** Active watches allowed per session. */
  maxSubscriptionsPerSession: number
  /** Queued wakeups kept per session before the oldest drop (with a warning). */
  maxPendingWakeups: number
  /** Probe interval used when a watch does not specify one (seconds). */
  defaultIntervalSeconds: number
  /** Cooldown used when a watch does not specify one (seconds). */
  defaultCooldownSeconds: number
  /**
   * Sentinel-duty lease TTL (ms): a second dsh process on the same DSH_HOME
   * stays passive (no probing, no delivery) while a fresh lease exists, and
   * takes over this long after the owner crashes or exits.
   */
  dutyLeaseTtlMs: number
  /**
   * Optional external notify webhook: every fire is POSTed there as JSON
   * (at-most-once; failures warn and never block the wakeup pipeline).
   * Point it at a Lark/WeCom/Slack bot or any receiver to fan sentinel
   * events out of the harness.
   */
  notifyWebhookUrl?: string
}

export const DEFAULT_CONFIG: Config = {
  locale: 'en',
  heartbeatMs: 5000,
  probeConcurrency: 8,
  maxSubscriptionsPerSession: MAX_SUBSCRIPTIONS_PER_AGENT,
  maxPendingWakeups: 8,
  defaultIntervalSeconds: DEFAULT_INTERVAL_SECONDS,
  defaultCooldownSeconds: DEFAULT_COOLDOWN_SECONDS,
  dutyLeaseTtlMs: 30_000,
}

export const Config: Schema<Config> = Schema.object({
  locale: Schema.union(['en', 'zh']).default('en').description('Language for server-generated tool receipts, wakeups and notifications. Browser UI follows the host locale independently.'),
  heartbeatMs: Schema.number().default(DEFAULT_CONFIG.heartbeatMs).description('Heartbeat interval driving all probe rounds (ms).'),
  probeConcurrency: Schema.number().default(DEFAULT_CONFIG.probeConcurrency).description('Upper bound on concurrently in-flight probes per heartbeat round.'),
  maxSubscriptionsPerSession: Schema.number().default(DEFAULT_CONFIG.maxSubscriptionsPerSession).description('Active watches allowed per session.'),
  maxPendingWakeups: Schema.number().default(DEFAULT_CONFIG.maxPendingWakeups).description('Queued wakeups kept per session before the oldest drop (with a warning).'),
  defaultIntervalSeconds: Schema.number().default(DEFAULT_CONFIG.defaultIntervalSeconds).description(`Probe interval used when a watch does not specify one (seconds, clamped to ${String(MIN_INTERVAL_SECONDS)}–${String(MAX_INTERVAL_SECONDS)}).`),
  defaultCooldownSeconds: Schema.number().default(DEFAULT_CONFIG.defaultCooldownSeconds).description('Cooldown used when a watch does not specify one (seconds).'),
  dutyLeaseTtlMs: Schema.number().default(DEFAULT_CONFIG.dutyLeaseTtlMs).description('Sentinel-duty lease TTL in ms: a second dsh process stays passive while a fresh lease exists; takeover happens this long after the owner dies.'),
  notifyWebhookUrl: Schema.string().description('Optional external notify webhook: every fire is POSTed there as JSON (at-most-once; failures never block wakeup delivery).'),
})

const PLUGIN_ID = 'dsh-sentinel'
export const STATE_PATH = `/plugins/${PLUGIN_ID}/state`
export const HOOK_PATH = `/plugins/${PLUGIN_ID}/hook`
export const CANCEL_PATH = `/plugins/${PLUGIN_ID}/cancel`
export const DASHBOARD_PATH = `/plugins/${PLUGIN_ID}/dashboard`
const PUSH_DEBOUNCE_MS = 250
/** fsWatch arm failures back off this long before retrying (heartbeat polling covers the gap). */
const FILE_WATCH_RETRY_MS = 60_000
/** Compact the sidecar at boot when rows exceed active subscriptions by this margin. */
const COMPACTION_MARGIN = 32

/** Sidecar log location: `$DSH_HOME/sentinel.jsonl` (the settings-file convention). */
export function storePath(): string {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return join(home, 'sentinel.jsonl')
}

/** Sentinel-duty lease location: `$DSH_HOME/sentinel.lease`. */
export function leasePath(): string {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return join(home, 'sentinel.lease')
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
  inject(deps: string[], callback: (ctx: ContextLike) => void): unknown
  get?: Context['get']
  readonly logger: { warn(message: string): void }
  readonly agents: {
    roots(): AgentLike[]
    get(id: string): AgentLike | undefined
    resume(options: ResumeAgentOptions): Promise<{ agent: AgentLike; dispose(): void | Promise<void> }>
  }
  readonly agentDefaultModel: {
    currentSelection(): ModelSelection
  }
  readonly tools: { register(definition: unknown): () => void }
  readonly webServer?: {
    /** Listening port (OS-assigned value when the config port is 0). */
    readonly port: number
    register(route: {
      kind: 'exact'
      path: string
      handler: (req: {
        url?: string
        method?: string
        headers?: Record<string, string | string[] | undefined>
        on(event: 'data' | 'end', callback: (chunk?: unknown) => void): void
      }, res: {
        writeHead(status: number, headers: Record<string, string>): void
        end(body: string): void
      }) => void | Promise<void>
    }): () => void
  }
}

/**
 * Browser-trust fence for this plugin's routes. The host fences its own /api
 * channels against cross-site POSTs and DNS rebinding, but plugin routes live
 * under /plugins/* outside that fence — and the hook route can wake a
 * full-access agent. Mirror the essentials: reject browser-marked cross-site
 * requests, and reject browser-marked requests whose Host/Origin authority is
 * a DNS name (rebinding cannot forge Host, and IP/localhost literals cannot
 * be rebound). Headerless clients (curl, CI jobs) pass untouched.
 */
function isLocalAuthority(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return true
  if (h.includes(':') && /^[0-9a-f:.]+$/.test(h)) return true
  return false
}

function requestAllowed(req: { headers?: Record<string, string | string[] | undefined> }): boolean {
  const headers = req.headers
  if (headers === undefined) return true
  const read = (name: string): string | undefined => {
    const value = headers[name]
    return Array.isArray(value) ? value[0] : value
  }
  const site = read('sec-fetch-site')
  if (site === 'cross-site') return false
  const origin = read('origin')
  const host = read('host')
  const browserMarked = site !== undefined || (origin !== undefined && origin !== 'null')
  if (!browserMarked) return true
  let authority = host ?? ''
  if (origin !== undefined && origin !== 'null') {
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      return false
    }
    if (host !== undefined && parsed.host.toLowerCase() !== host.toLowerCase()) return false
    authority = parsed.host
  }
  const hostname = authority.replace(/:\d+$/, '')
  return isLocalAuthority(hostname)
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
interface FireRecord extends FireMessage {
  readonly id: string
  readonly at: string
  readonly summary: string
  /** Subscription note at fire time — the wakeup context, shown by the UI. */
  readonly note: string
  /** Clipped snapshot excerpts, shown as the before → after transition. */
  readonly before: string
  readonly after: string
}

/** All sentinel state for one session; lives as long as the server, not the agent. */
class SessionWatch {
  folded: FoldedSentinel = { active: new Map(), lastOrdinal: 0, undeliveredFires: [] }
  rows: FoldableRow[] = []
  readonly probes = new Map<string, ProbeState>()
  readonly watchers = new Map<string, { watcher: FSWatcher; mode: 'direct' | 'parent' }>()
  /** Last fsWatch arm failure per subscription; arms back off for FILE_WATCH_RETRY_MS. */
  readonly watchFailures = new Map<string, number>()
  readonly pushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly recentFires: FireRecord[] = []
  readonly pendingWakeups: string[] = []
  /** Cumulative wakeups dropped by the pending-queue cap (visible, not silent). */
  droppedWakeups = 0

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
  private readonly dutyLeasePath = leasePath()
  private readonly pendingRounds = new Set<Promise<void>>()
  private ready = false
  private activeDrive: Promise<void> | undefined
  private disposed = false
  /** This process owns probing/delivery. False while another instance's lease is fresh. */
  private duty = false

  constructor(
    private readonly ctx: ContextLike,
    private readonly store: SentinelStore,
    readonly config: Config,
  ) {}

  start(): void {
    this.trackRound((async () => {
      await this.claimDuty()
      this.ready = true
      await this.loadPersisted()
      if (this.disposed) return
      this.timer = setInterval(() => {
        if (this.pendingRounds.size === 0) this.trackRound(this.drive())
      }, this.config.heartbeatMs)
      // One-shot profiles must not stay alive solely for the sentinel heartbeat.
      this.timer.unref()
    })())
  }

  /** Keep startup and heartbeat file operations owned until teardown completes. */
  private trackRound(round: Promise<void>): void {
    const settled = round.finally(() => { this.pendingRounds.delete(settled) })
    this.pendingRounds.add(settled)
    void settled
  }

  /**
   * Sentinel duty lease: one probing/delivering owner per DSH_HOME. A fresh
   * lease held by a live pid keeps this instance passive (tools still work,
   * writes still persist); the passive side re-checks every heartbeat and
   * takes over once the owner's lease goes stale. The claim race window is
   * one heartbeat at worst — the TTL self-heals a double claim.
   */
  private async claimDuty(): Promise<void> {
    const lease = await this.readLease()
    if (lease !== undefined
      && Date.now() - lease.at < this.config.dutyLeaseTtlMs
      && this.pidAlive(lease.pid)) {
      this.duty = false
      this.warn(`another dsh process (pid ${String(lease.pid)}) owns sentinel duty; staying passive until its lease goes stale`)
      return
    }
    try {
      await this.writeLease()
      // Lost a simultaneous claim? The winner's pid is on disk now.
      await sleep(150)
      const reread = await this.readLease()
      this.duty = reread?.pid === process.pid
      if (!this.duty) this.warn(`lost the sentinel-duty claim to pid ${String(reread?.pid ?? 'unknown')}; staying passive`)
    } catch (error: unknown) {
      // Cannot write the lease: never probe on ambiguity, the owner might exist.
      this.duty = false
      this.warn(`sentinel-duty lease write failed: ${describe(error)}; staying passive`)
    }
  }

  private async renewLease(): Promise<void> {
    try {
      await this.writeLease()
    } catch (error: unknown) {
      this.warn(`sentinel-duty lease renewal failed: ${describe(error)}`)
    }
  }

  private async readLease(): Promise<{ pid: number; at: number } | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.dutyLeasePath, 'utf8')) as { pid?: unknown; at?: unknown }
      if (typeof parsed.pid !== 'number' || typeof parsed.at !== 'number') return undefined
      return { pid: parsed.pid, at: parsed.at }
    } catch {
      return undefined
    }
  }

  private async writeLease(): Promise<void> {
    const path = this.dutyLeasePath
    const tmp = `${path}.tmp`
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8')
    await rename(tmp, path)
  }

  private pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error: unknown) {
      // EPERM means the process exists under another user.
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  /** Absolute webhook URL when the web server port is known; bare path in
   * headless (no webServer), where nothing listens anyway. The session
   * qualifier disambiguates watch ids, which are allocated per session. */
  hookUrl(sessionId: string, id: string): string {
    const port = this.ctx.webServer?.port
    const path = `${HOOK_PATH}?id=${id}&s=${encodeURIComponent(sessionId)}`
    return port === undefined ? path : `http://localhost:${String(port)}${path}`
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    for (const watch of this.watches.values()) watch.closeSensors()
    await Promise.all(this.pendingRounds)
    await this.activeDrive
    if (this.duty) await unlink(this.dutyLeasePath).catch(() => {})
    this.watches.clear()
    for (const handle of this.handles.splice(0, this.handles.length)) {
      await Promise.resolve().then(() => handle.dispose()).catch(() => {})
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
      this.requeueUndelivered(watch)
      if (watch.folded.active.size === 0 && watch.pendingWakeups.length === 0) {
        watch.closeSensors()
        this.watches.delete(sessionId)
      }
    }
    this.compact(totalRows)
    await this.drive()
  }

  /** Crash-window recovery: fires logged after the latest delivered watermark
   * requeue now (oldest first, capped like any batch) so a crash between
   * logging and delivering cannot lose the wakeup. */
  private requeueUndelivered(watch: SessionWatch): void {
    const pending = watch.folded.undeliveredFires
    if (pending.length === 0) return
    const capped = pending.slice(-this.config.maxPendingWakeups)
    watch.pendingWakeups.push(...capped.map(entry => renderWakeup(entry.sub, entry.fact, this.config.locale ?? 'en')))
    const dropped = pending.length - capped.length
    if (dropped > 0) {
      watch.droppedWakeups += dropped
      this.warn(`requeue for "${watch.sessionId}": dropped ${String(dropped)} oldest undelivered wakeup(s) over the cap`)
    }
    this.warn(`requeued ${String(pending.length)} undelivered wakeup(s) for "${watch.sessionId}"`)
  }

  /**
   * Adopt rows another process appended: with the duty lease, a passive
   * instance still serves tools and writes the shared sidecar, so the duty
   * owner re-reads the log each heartbeat and folds anything past its
   * in-memory picture. The file only ever grows past our rows (our own
   * appends push rows first), so a length comparison is the adoption test.
   */
  private async syncFromStore(): Promise<void> {
    let grouped: Map<string, FoldableRow[]>
    try {
      grouped = await this.store.load()
    } catch {
      return
    }
    if (this.disposed) return
    for (const [sessionId, rows] of grouped) {
      const watch = this.watchOf(sessionId)
      if (rows.length <= watch.rows.length) continue
      watch.rows = rows
      this.refold(watch)
      this.requeueUndelivered(watch)
    }
  }

  /**
   * Rewrite a history-heavy sidecar as one 'compacted' row per active
   * subscription (fire budget and last observation intact). Fire-and-forget:
   * later appends ride the store chain, so they land after the rewrite.
   */
  private compact(totalRows: number): void {
    let activeCount = 0
    for (const watch of this.watches.values()) {
      activeCount += watch.folded.active.size
      // History still owes wakeups: rewriting now would drop them. Retry next boot.
      if (watch.folded.undeliveredFires.length > 0) return
    }
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
      () => {
        this.warn(`sidecar compacted: ${String(totalRows)} rows -> ${String(lines.length)}`)
        // Collapse the in-memory histories to the same compacted rows so
        // later commits refold one row per subscription instead of the whole
        // pre-compaction history (and store sync lengths line up again).
        for (const watch of this.watches.values()) {
          watch.rows = [...watch.folded.active.values()].map(sub => ({
            type: SENTINEL_CHANGE_TYPE,
            payload: { version: SENTINEL_CHANGE_VERSION, change: 'compacted', subscription: sub } as SentinelChange,
          }))
          this.refold(watch)
        }
      },
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

  /** Duty-lease liveness for the transparency routes: who owns duty and how fresh its heartbeat is. */
  async dutyStatus(): Promise<{ pid: number; at: number; ageMs: number; stale: boolean } | undefined> {
    const lease = await this.readLease()
    if (lease === undefined) return undefined
    const ageMs = Date.now() - lease.at
    return {
      pid: lease.pid,
      at: lease.at,
      ageMs,
      stale: ageMs >= this.config.dutyLeaseTtlMs || !this.pidAlive(lease.pid),
    }
  }

  /** Resolve the session for an inbound webhook push. Watch ids are only
   * unique per session, so the URL's session qualifier decides; URLs baked
   * into external systems before the qualifier existed fall back to the
   * first matching webhook watch. */
  resolveWebhookTarget(sessionId: string | null, id: string): SessionWatch | undefined {
    if (sessionId !== null && sessionId !== '') {
      const watch = this.watches.get(sessionId)
      return watch !== undefined && watch.folded.active.has(id) ? watch : undefined
    }
    for (const watch of this.watches.values()) {
      const sub = watch.folded.active.get(id)
      if (sub !== undefined && sub.spec.kind === 'webhook') return watch
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
      watch.folded = { active: new Map(), lastOrdinal: 0, undeliveredFires: [] }
    }
    for (const id of [...watch.probes.keys()]) {
      if (!watch.folded.active.has(id)) watch.probes.delete(id)
    }
    for (const id of [...watch.watchFailures.keys()]) {
      if (!watch.folded.active.has(id)) watch.watchFailures.delete(id)
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
          const selection = this.ctx.agentDefaultModel.currentSelection()
          const handle = await this.ctx.agents.resume({
            resumeSessionId: sessionId as ResumeAgentOptions['resumeSessionId'],
            agentOptions: { ...selection },
            setup: async (agentCtx, agent) => {
              const presets = this.ctx.get?.('agentPresets')
              if (presets === undefined) return
              const projections = this.ctx.get?.('sessionProjections')
              if (projections === undefined) throw new Error('dsh-sentinel: agentPresets requires sessionProjections to restore the saved preset')
              const presetId = projections.stateOf(agent.session, 'agentPreset') ?? undefined
              await presets.mount(agentCtx, presetId)
            },
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
    if (watch.folded.active.size >= this.config.maxSubscriptionsPerSession) {
      throw new SentinelLogError(`subscription limit reached (${String(this.config.maxSubscriptionsPerSession)}); cancel one first`)
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
  async cancel(sessionId: string, id: string, reason: 'agent' | 'user' | 'expired' | 'exhausted'): Promise<boolean> {
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

  /**
   * One heartbeat round: collect every due probe (and expiry cancel) across all
   * sessions, then run them in bounded-concurrency batches. The `probing` flag
   * keeps a re-entered round (push probe, create, previous round still in
   * flight) from double-probing the same subscription; deliveries flush once
   * after the batches settle.
   */
  private async drive(): Promise<void> {
    if (this.disposed || !this.ready) return
    if (this.activeDrive !== undefined) return this.activeDrive
    const round = this.driveRound()
    this.activeDrive = round
    try {
      await round
    } finally {
      this.activeDrive = undefined
    }
  }

  private async driveRound(): Promise<void> {
    if (this.disposed) return
    if (this.duty) {
      await this.renewLease()
    } else {
      await this.claimDuty()
      if (!this.duty) return
    }
    await this.syncFromStore()
    const tasks: Array<() => Promise<void>> = []
    const now = Date.now()
    for (const watch of [...this.watches.values()]) {
      for (const sub of [...watch.folded.active.values()]) {
        if (sub.expiresAt !== undefined && Date.parse(sub.expiresAt) <= now) {
          tasks.push(async () => {
            try {
              await this.cancel(watch.sessionId, sub.id, 'expired')
            } catch (error: unknown) {
              this.warn(`expiry cancel failed for ${sub.id}: ${describe(error)}`)
            }
          })
          continue
        }
        if (sub.spec.kind === 'webhook') continue
        const state = watch.probes.get(sub.id)
        if (state === undefined || state.probing || state.nextDueAt > now) continue
        if (sub.lastFiredAt !== undefined
          && now - Date.parse(sub.lastFiredAt) < sub.cooldownSeconds * 1000) continue
        state.probing = true
        tasks.push(async () => {
          try {
            await this.probeOne(watch, sub, state)
          } finally {
            state.probing = false
            state.lastProbeAt = Date.now()
            state.nextDueAt = Date.now() + sub.spec.intervalSeconds * 1000
          }
        })
      }
    }
    for (let index = 0; index < tasks.length; index += this.config.probeConcurrency) {
      await Promise.allSettled(tasks.slice(index, index + this.config.probeConcurrency).map(task => task()))
    }
    if (this.disposed) return
    for (const watch of [...this.watches.values()]) this.flushWakeups(watch)
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
        summary: formatFireSummary({ summary: '', trigger: { kind: 'webhook' } }, this.config.locale ?? 'en'),
        trigger: { kind: 'webhook' },
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
    watch.recentFires.unshift({
      id: sub.id, at, summary: fact.summary, trigger: fact.trigger, state: fact.state,
      note: sub.note, before: fact.before, after: fact.after,
    })
    if (watch.recentFires.length > 20) watch.recentFires.pop()
    void this.notifyFire(watch, sub, fact)
    // Only the duty owner queues in-memory wakeups; on a passive instance the
    // queue would never drain — the owner requeues this fire from the log.
    if (!this.duty) return
    watch.pendingWakeups.push(renderWakeup(sub, fact, this.config.locale ?? 'en'))
    if (watch.pendingWakeups.length > this.config.maxPendingWakeups) {
      const dropped = watch.pendingWakeups.length - this.config.maxPendingWakeups
      watch.pendingWakeups.splice(0, dropped)
      watch.droppedWakeups += dropped
      this.warn(`pending wakeup overflow for "${watch.sessionId}": dropped ${String(dropped)} oldest (agent busy?)`)
    }
  }

  /** Fan one fire out to the optional external notify webhook. At-most-once:
   * a failed POST warns and never blocks the wakeup pipeline. */
  private async notifyFire(watch: SessionWatch, sub: Subscription, fact: FireFact): Promise<void> {
    const url = this.config.notifyWebhookUrl
    if (url === undefined || url === '') return
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, 5000)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          plugin: PLUGIN_ID,
          event: 'fired',
          sessionId: watch.sessionId,
          id: sub.id,
          kind: sub.spec.kind,
          target: sub.spec.target,
          note: sub.note,
          fireNumber: fact.fireNumber,
          maxFires: sub.maxFires,
          summary: formatFireSummary(fact, this.config.locale ?? 'en'),
          trigger: fact.trigger,
          state: fact.state,
          after: fact.after,
        }),
      })
      if (!response.ok) this.warn(`notify webhook returned HTTP ${String(response.status)}`)
    } catch (error: unknown) {
      this.warn(`notify webhook failed: ${describe(error)}`)
    } finally {
      clearTimeout(timer)
    }
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
        summary: formatFireSummary({ summary: decision.summary, trigger: decision.trigger, state: result.state }, this.config.locale ?? 'en'),
        trigger: decision.trigger,
        state: result.state,
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
    if (!this.duty || watch.pendingWakeups.length === 0) return
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
        source: { kind: 'sentinel' },
      }))
    } catch (error: unknown) {
      this.warn(`wakeup delivery failed for session "${watch.sessionId}": ${describe(error)}`)
      watch.pendingWakeups.unshift(...batch)
      return
    }
    // Delivery watermark (at-least-once): if this write fails, the next boot
    // requeues the same batch once — a duplicate beats a lost wakeup.
    try {
      await this.commit(watch, { version: SENTINEL_CHANGE_VERSION, change: 'delivered', at: new Date().toISOString() })
    } catch (error: unknown) {
      this.warn(`delivered watermark write failed for "${watch.sessionId}": ${describe(error)}`)
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
  const locale = runtime.config.locale ?? 'en'

  disposers.push(toolCtx.tools.register(defineTool({
    name: 'sentinel_watch',
    description: [
      'Register a durable condition watch. The sentinel watches on the server side — even while this session',
      ' is closed or the agent is asleep — and wakes you with a structured report when the condition',
      ' transitions (a dormant session is resumed automatically), so do NOT poll or sleep for it yourself.',
      ' Watches survive process restarts. Probing and fire delivery happen in a long-running dsh process:',
      ' if this run is one-shot (headless), the watch is still persisted, but tell the user it only becomes',
      ' active once a resident process (e.g. "dsh web") is running. Kinds: "file" (path snapshot; inotify push, reacts in under a',
      ' second), "command" (read-only shell line probed on an interval; fires on output/exit change),',
      ' "http" (URL status+body probed on an interval), "process" (pgrep pattern probed on an interval),',
      ' "port" (TCP connect to "[host:]port" probed on an interval; fires on open/closed changes —',
      ' good for "database is up", "dev server died"),',
      ' "webhook" (pure push: returns a hook URL, any external system can POST to it to wake you —',
      ' put a curl into a CI job, git hook, or another machine\'s script). With "pattern", probe kinds fire',
      ' on the no-match→match edge of that regex and webhooks fire only when the payload matches;',
      ' without it, probe kinds fire on any snapshot change after the baseline and webhooks fire on any POST.',
    ].join(''),
    parameters: {
      kind: {
        type: 'string',
        required: true,
        enum: ['file', 'command', 'http', 'process', 'port', 'webhook'],
        description: 'Sensor engine: probing (file/command/http/process/port) or pure push (webhook).',
      },
      target: {
        type: 'string',
        required: true,
        description: 'file: absolute path; command: read-only shell line; http: URL; process: pgrep -f pattern; port: "[host:]port"; webhook: short label naming the expected caller.',
      },
      pattern: {
        type: 'string',
        description: 'Optional regex in JavaScript RegExp syntax (compiled with the m flag; RE2 inline flags like (?s) are invalid — write [\\s\\S]+ instead). Probe kinds fire on its no-match→match transition over real probe content; placeholder states (missing file, unreachable URL, no matching process) never match. Webhooks only accept payloads it matches.',
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
        textBlock(translate(locale, 'registered', { id: value.id, kind: value.kind, target: value.target }) + (value.hookPath !== undefined
          ? '\n' + translate(locale, 'hookAddress', { url: value.hookPath })
            + (value.hookPath.startsWith('http') ? translate(locale, 'hookHost') : '') + translate(locale, 'hookResident')
          : translate(locale, 'probeCadence', {
            interval: value.intervalSeconds,
            filePush: value.kind === 'file' ? translate(locale, 'filePush') : '',
          }))),
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
      const cooldown = args.cooldown_seconds !== undefined ? Math.max(0, Math.round(args.cooldown_seconds)) : runtime.config.defaultCooldownSeconds
      const expires = args.expires_in_seconds !== undefined ? Math.max(runtime.config.heartbeatMs / 1000, Math.round(args.expires_in_seconds)) : undefined
      const subscription = await runtime.create(
        agent.id,
        {
          kind: args.kind,
          target: args.target,
          ...(args.pattern !== undefined ? { pattern: args.pattern } : {}),
          intervalSeconds: args.interval_seconds ?? runtime.config.defaultIntervalSeconds,
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
          ? { hookPath: runtime.hookUrl(agent.id, subscription.id) }
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
          ? translate(locale, 'noWatches')
          : value.subscriptions.map(row => translate(locale, 'listRow', {
            id: row.id, kind: row.kind, target: row.target,
            state: row.lastState === undefined ? translate(locale, 'notProbed') : localizeState(row.lastState, locale),
            count: row.fireCount, max: row.maxFires,
          })).join('\n')),
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
        textBlock(translate(locale, value.cancelled ? 'cancelled' : 'notFound', { id: value.id })),
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
  /** Fires logged but not yet delivered to the session (dormant or gone). */
  pendingWakeups: number
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
        pendingWakeups: watch.pendingWakeups.length,
      })
    }
  }
  return rows
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
    handler: async (req, res) => {
      try {
        if (!requestAllowed(req)) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'forbidden' }))
          return
        }
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const rows: unknown[] = collectWatchRows(runtime, ctx, sessionId)
        const fires: unknown[] = []
        const dropped: Record<string, number> = {}
        for (const [id, watch] of runtime.view()) {
          if (sessionId !== '' && id !== sessionId) continue
          fires.push(...watch.recentFires.map(fire => ({ sessionId: id, ...fire })))
          if (watch.droppedWakeups > 0) dropped[id] = watch.droppedWakeups
        }
        const duty = await runtime.dutyStatus()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ watches: rows, recentFires: fires, droppedWakeups: dropped, duty }))
      } catch (error: unknown) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: describe(error) }))
      }
    },
  })

  const stopDashboard = webServer.register({
    kind: 'exact',
    path: DASHBOARD_PATH,
    handler: (req, res) => {
      try {
        if (!requestAllowed(req)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('forbidden')
          return
        }
        const rows = collectWatchRows(runtime, ctx, '')
        const fires: Array<{ sessionId: string } & FireRecord> = []
        const dropped: Record<string, number> = {}
        for (const [id, watch] of runtime.view()) {
          fires.push(...watch.recentFires.map(fire => ({ sessionId: id, ...fire })))
          if (watch.droppedWakeups > 0) dropped[id] = watch.droppedWakeups
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const language = url.searchParams.get('lang')
        const accept = req.headers?.['accept-language']
        const locale = language !== null ? resolveLocale(language)
          : resolveLocale((Array.isArray(accept) ? accept[0] : accept)?.split(',')[0]?.split(';')[0] ?? runtime.config.locale)
        res.end(dashboardHtml(rows, fires, dropped, locale))
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
      if (!requestAllowed(req)) {
        respond(403, { fired: false, reason: 'forbidden' })
        return
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
        const watch = runtime.resolveWebhookTarget(url.searchParams.get('s'), id)
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

  const stopCancel = webServer.register({
    kind: 'exact',
    path: CANCEL_PATH,
    handler: (req, res) => {
      const respond = (status: number, body: Record<string, unknown>): void => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      }
      if (!requestAllowed(req)) {
        respond(403, { cancelled: false, reason: 'forbidden' })
        return
      }
      if ((req.method ?? 'GET') !== 'POST') {
        respond(405, { cancelled: false, reason: 'POST only' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const id = url.searchParams.get('id') ?? ''
      if (sessionId === '' || id === '') {
        respond(400, { cancelled: false, reason: 'sessionId and id are required' })
        return
      }
      void runtime.cancel(sessionId, id, 'user').then(
        ok => respond(ok ? 200 : 404, ok
          ? { cancelled: true, sessionId, id }
          : { cancelled: false, reason: 'no such watch' }),
        (error: unknown) => respond(500, { cancelled: false, reason: describe(error) }),
      )
    },
  })

  return () => {
    stopRoute()
    stopDashboard()
    stopHook()
    stopCancel()
  }
}

export function apply(ctx: ContextLike, config: Config = DEFAULT_CONFIG): void {
  ctx.effect(() => {
    const runtime = new SentinelRuntime(ctx, new SentinelStore(storePath()), config)
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

    return async () => {
      stopping = true
      if (typeof stopRoutes === 'function') stopRoutes()
      stopCreated()
      await runtime.dispose()
    }
  }, `${PLUGIN_ID}.lifecycle()`)
}
