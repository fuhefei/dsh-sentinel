/**
 * A self-scheduling poller for the sentinel client.
 *
 * The previous implementation armed a `setInterval` and fired a request on
 * every tick without looking at the previous one, so a slow server made
 * requests pile up, and teardown only cleared the timer — work already in
 * flight kept running into a dead component. This poller fixes both:
 *
 *   - the next tick is armed only after the previous request settles, so at
 *     most one request is ever in flight per poller;
 *   - every request carries an abort signal, so `stop()` cancels work in
 *     flight rather than leaving it to resolve later.
 *
 * A per-request timeout is not optional here: because the loop re-arms itself
 * *after* the request settles, one request that never settles would otherwise
 * stall the poller forever. The timeout bounds that.
 *
 * The poller can also be gated by page visibility: while the page is hidden no
 * request is made and no timer stays armed, and it resumes with an immediate
 * refresh when the page becomes visible again. The gate is injected
 * ({@link PollerVisibility}) so the module stays free of DOM globals;
 * {@link documentVisibility} adapts `document.visibilityState`.
 *
 * Deliberately free of React and DOM APIs so the scheduling contract can be
 * unit-tested directly.
 * @module dsh-sentinel/client/poller
 */

/** Per-request ceiling. A poll may not outlive this. */
export const DEFAULT_POLL_TIMEOUT_MS = 10_000

/** Source of the page-visibility signal that gates a poller. */
export interface PollerVisibility {
  /** Whether the page is hidden right now. */
  hidden(): boolean
  /** Call `listener` on every visibility change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
}

/**
 * Visibility gate backed by the Page Visibility API.
 * @returns a {@link PollerVisibility} over `document`, or `undefined` outside a full browser document.
 */
export function documentVisibility(): PollerVisibility | undefined {
  // Partial `document` stand-ins (tests, embedded views) without the full event API poll as before.
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function'
    || typeof document.removeEventListener !== 'function' || typeof document.visibilityState !== 'string') return undefined
  return {
    hidden: () => document.visibilityState === 'hidden',
    subscribe: (listener) => {
      document.addEventListener('visibilitychange', listener)
      return () => { document.removeEventListener('visibilitychange', listener) }
    },
  }
}

export interface PollerOptions {
  /** Delay between the end of one request and the start of the next. */
  intervalMs: number
  /** Per-request ceiling; defaults to {@link DEFAULT_POLL_TIMEOUT_MS}. */
  timeoutMs?: number
  /** One request. Receives a signal that aborts on timeout or on `stop()`. */
  run: (signal: AbortSignal) => Promise<void>
  /** Called when `run` rejects. Aborts are not reported. */
  onError?: (error: unknown) => void
  /**
   * Pause while the page is hidden; resume with an immediate request when it is visible again.
   * Defaults to {@link documentVisibility} in a browser; pass `null` to poll regardless.
   */
  visibility?: PollerVisibility | null
}

export interface Poller {
  /** Begin polling. Idempotent while already running. */
  start(): void
  /** Cancel any in-flight request and stop scheduling. Idempotent. */
  stop(): void
  /** Whether the poller is currently scheduling. */
  readonly running: boolean
  /** Number of requests currently in flight (0 or 1). Exposed for tests. */
  readonly inFlight: number
}

/**
 * Combine the owner's signal with a per-request timeout.
 * @param outer - owner signal; aborting it aborts the request.
 * @param timeoutMs - per-request ceiling.
 * @returns the request signal plus a disposer that clears the timer and listener.
 */
function requestSignal(outer: AbortSignal, timeoutMs: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController()
  const forward = (): void => { controller.abort() }
  if (outer.aborted) controller.abort()
  else outer.addEventListener('abort', forward, { once: true })
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer)
      outer.removeEventListener('abort', forward)
    },
  }
}

/**
 * Create a self-scheduling poller. All state is per-instance, so several
 * pollers (one per session view, one shared page-wide) never interfere.
 * @param options - interval, timeout, the request body, and an error hook.
 * @returns the poller handle.
 */
export function createPoller(options: PollerOptions): Poller {
  const { intervalMs, run, onError } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  let visibility: PollerVisibility | undefined
  let owner: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined
  let paused = false
  let inFlight = 0

  const tick = async (): Promise<void> => {
    const signal = owner?.signal
    if (signal === undefined || signal.aborted) return
    // A hidden page makes no request and arms no timer; the visibility listener restarts the loop.
    if (visibility?.hidden() === true) { paused = true; return }
    paused = false
    const request = requestSignal(signal, timeoutMs)
    inFlight += 1
    try {
      await run(request.signal)
    } catch (error) {
      // An abort is an expected shutdown/timeout outcome, not a poll failure.
      if (!request.signal.aborted) onError?.(error)
    } finally {
      inFlight -= 1
      request.done()
    }
    // Re-arm only after the request settled, and only while still running.
    if (signal.aborted || owner === undefined) return
    // Hidden meanwhile: stay paused instead of arming a timer that would only wake up to find that out.
    if (visibility?.hidden() === true) { paused = true; return }
    timer = setTimeout(() => { void tick() }, intervalMs)
  }

  return {
    start() {
      if (owner !== undefined) return
      owner = new AbortController()
      const gate = options.visibility === null ? undefined : (options.visibility ?? documentVisibility())
      visibility = gate
      unsubscribe = gate?.subscribe(() => {
        if (owner === undefined) return
        if (gate.hidden()) {
          // Drop the pending timer; a request already in flight is allowed to finish and then stays paused.
          if (timer !== undefined) { clearTimeout(timer); timer = undefined }
          paused = true
          return
        }
        if (!paused) return
        paused = false
        // With a request still in flight, its completion re-arms the loop.
        if (inFlight === 0) void tick()
      })
      void tick()
    },
    stop() {
      const current = owner
      owner = undefined
      unsubscribe?.()
      unsubscribe = undefined
      paused = false
      current?.abort()
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    },
    get running() { return owner !== undefined },
    get inFlight() { return inFlight },
  }
}
