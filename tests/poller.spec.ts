/**
 * Regression tests for the client poller (issue #13).
 *
 * The reported defect: the client armed a `setInterval` and fired a request on
 * every tick regardless of whether the previous one had settled, so a slow
 * server accumulated overlapping requests, and unsubscribing cleared the timer
 * without cancelling work already in flight. These tests pin the two
 * guarantees that fix it — at most one request in flight, and cancellation on
 * stop — plus the timeout that keeps a hung request from stalling the loop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPoller } from '../src/client/poller.ts'

/** A request whose settlement the test controls, recording overlap.
 * Rejects on abort, the way a real `fetch` does — without that the promise
 * would never settle and the loop could not re-arm. */
function hangable() {
  let inFlight = 0
  let maxInFlight = 0
  const settle: Array<() => void> = []
  const signals: AbortSignal[] = []
  const run = (signal: AbortSignal): Promise<void> => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    signals.push(signal)
    return new Promise<void>((resolve, reject) => {
      const entry = { done: false }
      const finish = (): void => {
        if (entry.done) return
        entry.done = true
        inFlight -= 1
        resolve()
      }
      settle.push(finish)
      signal.addEventListener('abort', () => {
        if (entry.done) return
        entry.done = true
        inFlight -= 1
        reject(new Error('aborted'))
      }, { once: true })
    })
  }
  return {
    run,
    signals,
    get inFlight() { return inFlight },
    get maxInFlight() { return maxInFlight },
    get calls() { return signals.length },
    release(): void { settle.shift()?.() },
  }
}

describe('createPoller', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('never lets a hanging request accumulate a second one', async () => {
    const server = hangable()
    const poller = createPoller({ intervalMs: 1000, timeoutMs: 60_000, run: server.run })
    poller.start()
    // Many poll intervals pass with the first request outstanding. The old
    // setInterval design produced one request per tick here.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(server.calls).toBe(1)
    expect(server.maxInFlight).toBe(1)
    expect(poller.inFlight).toBe(1)
    poller.stop()
  })

  it('arms the next request only after the previous one settles', async () => {
    const server = hangable()
    const poller = createPoller({ intervalMs: 1000, timeoutMs: 60_000, run: server.run })
    poller.start()
    await vi.advanceTimersByTimeAsync(3500)
    expect(server.calls).toBe(1)          // still waiting on the first
    server.release()                      // settles at t=3500
    await vi.advanceTimersByTimeAsync(999)
    expect(server.calls).toBe(1)          // interval not elapsed yet
    await vi.advanceTimersByTimeAsync(1)
    expect(server.calls).toBe(2)          // next tick exactly one interval later
    expect(server.maxInFlight).toBe(1)
    poller.stop()
  })

  it('aborts the in-flight request on stop', async () => {
    const server = hangable()
    const poller = createPoller({ intervalMs: 1000, timeoutMs: 60_000, run: server.run })
    poller.start()
    await vi.advanceTimersByTimeAsync(1500)
    const signal = server.signals[0]
    expect(signal?.aborted).toBe(false)
    poller.stop()
    expect(signal?.aborted).toBe(true)    // cancellation, not just a cleared timer
    // and it must not re-arm afterwards
    await vi.advanceTimersByTimeAsync(10_000)
    expect(server.calls).toBe(1)
    expect(poller.running).toBe(false)
  })

  it('times out a hung request and keeps polling', async () => {
    const server = hangable()
    const poller = createPoller({ intervalMs: 1000, timeoutMs: 2000, run: server.run })
    poller.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(server.signals[0]?.aborted).toBe(true)   // timeout fired
    // past the timeout, the loop re-arms one interval later (t=3000); the extra
    // millisecond absorbs the microtask hop between abort and re-arm
    await vi.advanceTimersByTimeAsync(1100)
    expect(server.calls).toBe(2)                    // loop survived the hang
    expect(server.maxInFlight).toBe(1)
    poller.stop()
  })

  it('does not report aborts as errors', async () => {
    const onError = vi.fn()
    const poller = createPoller({
      intervalMs: 1000,
      timeoutMs: 2000,
      run: (signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
      onError,
    })
    poller.start()
    await vi.advanceTimersByTimeAsync(2000)   // timeout abort
    poller.stop()
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports a genuine failure through onError but keeps polling', async () => {
    const onError = vi.fn()
    let calls = 0
    const poller = createPoller({
      intervalMs: 1000,
      timeoutMs: 60_000,
      run: async () => { calls += 1; throw new Error('network down') },
      onError,
    })
    poller.start()
    await vi.advanceTimersByTimeAsync(3000)
    // t=0 plus one retry per interval at 1000/2000/3000
    expect(onError).toHaveBeenCalledTimes(4)
    expect(calls).toBe(4)
    poller.stop()
  })

  it('start is idempotent while running', async () => {
    const server = hangable()
    const poller = createPoller({ intervalMs: 1000, timeoutMs: 60_000, run: server.run })
    poller.start()
    poller.start()
    poller.start()
    expect(server.calls).toBe(1)
    poller.stop()
  })

  it('can be restarted after stop', async () => {
    const server = hangable()
    const poller = createPoller({ intervalMs: 1000, timeoutMs: 60_000, run: server.run })
    poller.start()
    expect(server.calls).toBe(1)
    poller.stop()
    poller.start()
    await vi.advanceTimersByTimeAsync(1)
    expect(server.calls).toBe(2)
    expect(poller.running).toBe(true)
    poller.stop()
  })
})
