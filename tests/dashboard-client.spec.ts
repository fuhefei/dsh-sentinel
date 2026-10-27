import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startDashboard } from '../src/dashboard-client.ts'
import type { DashboardState } from '../src/dashboard-view.ts'
import type { WatchRow } from '../src/index.ts'

class FakeTarget {
  readonly listeners = new Map<string, Set<(event: Event) => void>>()
  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }
  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }
  emit(type: string, event: object = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as Event)
  }
}

class FakeButton {
  disabled = false
  constructor(readonly attributes: Record<string, string>) {}
  getAttribute(name: string): string | null { return this.attributes[name] ?? null }
  closest(selector: string): FakeButton | null { return selector === 'button.cancel' ? this : null }
}

class FakeNode extends FakeTarget {
  innerHTML = 'server-rendered frame'
  textContent = ''
  readonly buttons = new Set<FakeButton>()
  contains(button: FakeButton): boolean { return this.buttons.has(button) }
  attachButton(sessionId: string, id: string): FakeButton {
    const button = new FakeButton({ 'data-session': sessionId, 'data-id': id })
    this.buttons.add(button)
    return button
  }
  click(button: FakeButton): void { this.emit('click', { target: button }) }
}

function watch(overrides: Partial<WatchRow> = {}): WatchRow {
  return {
    sessionId: 'session-review', live: true, id: 'watch-1', kind: 'file', target: '"><img src=x>',
    intervalSeconds: 30, note: '用户 note $& {{id}}', fireCount: 1, maxFires: 2,
    createdAt: '2026-01-01T00:00:00Z', pendingWakeups: 2, lastState: 'absent',
    ...overrides,
  }
}

function fixture(): DashboardState {
  return {
    watches: [watch()],
    recentFires: [{
      sessionId: 'session-review', id: 'watch-1', at: '2026-01-01T00:00:00Z', summary: '旧摘要',
      trigger: { kind: 'pattern', pattern: 'READY', match: 'READY </script> $& {{id}}' }, state: 'exit 0',
    }],
    droppedWakeups: { 'session-review': 3 }, duty: { ageMs: 2000, stale: true },
  }
}

function response(data: DashboardState, ok = true): Response {
  return { ok, json: async () => data } as Response
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

let nodes: Record<'rows' | 'fires' | 'meta', FakeNode>
let lifecycle: FakeTarget
let state: DashboardState
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
const disposers: Array<() => void> = []
const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0) }

function start(locale = 'en'): () => void {
  vi.stubGlobal('document', {
    documentElement: { lang: locale }, defaultView: lifecycle,
    getElementById: (id: keyof typeof nodes) => nodes[id] ?? null,
  })
  const dispose = startDashboard()
  disposers.push(dispose)
  return dispose
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  nodes = { rows: new FakeNode(), fires: new FakeNode(), meta: new FakeNode() }
  lifecycle = new FakeTarget()
  state = fixture()
  fetchMock = vi.fn<typeof fetch>(async () => response(state))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose()
  await flush()
  const timerCount = vi.getTimerCount()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  expect(timerCount).toBe(0)
})

describe('standalone dashboard browser module', () => {
  it.each([
    { locale: 'en', browser: 'zh-CN', history: 'Pattern /READY/ started matching:', absent: 'absent', empty: 'No active watches right now.', noFires: 'No fires yet.', pending: '2 pending', dropped: '3 dropped', duty: 'duty heartbeat stale (2s ago)' },
    { locale: 'zh-CN', browser: 'en-US', history: '模式 /READY/ 开始匹配:', absent: '不存在', empty: '当前没有活跃的监控。', noFires: '尚未触发过。', pending: '待投递 2', dropped: '已丢弃 3 唤醒', duty: '值守心跳 2s 前（疑似停摆）' },
  ])('uses server-selected $locale for updates, empty states and escaping', async values => {
    vi.stubGlobal('navigator', { language: values.browser })
    start(values.locale)
    await flush()
    expect(nodes.rows.innerHTML).toContain(values.absent)
    expect(nodes.rows.innerHTML).toContain(values.pending)
    expect(nodes.rows.innerHTML).toContain(values.dropped)
    expect(nodes.rows.innerHTML).toContain('&quot;&gt;&lt;img src=x&gt;')
    expect(nodes.rows.innerHTML).not.toContain('<img src=x>')
    expect(nodes.fires.innerHTML).toContain(values.history)
    expect(nodes.fires.innerHTML).toContain('READY &lt;/script&gt; $&amp; {{id}}')
    expect(nodes.fires.innerHTML).not.toContain('</script>')
    expect(nodes.meta.textContent).toContain(values.duty)
    expect(fetchMock).toHaveBeenCalledWith('/plugins/dsh-sentinel/state', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    state = { watches: [], recentFires: [] }
    await vi.advanceTimersByTimeAsync(3000)
    expect(nodes.rows.innerHTML).toContain(values.empty)
    expect(nodes.fires.innerHTML).toContain(values.noFires)
  })

  it('preserves the last frame after a failed HTTP poll and retries normally', async () => {
    start()
    await flush()
    const lastRows = nodes.rows.innerHTML
    fetchMock.mockResolvedValueOnce(response({ watches: [], recentFires: [] }, false))
    await vi.advanceTimersByTimeAsync(3000)
    expect(nodes.rows.innerHTML).toBe(lastRows)
    state = { watches: [], recentFires: [] }
    await vi.advanceTimersByTimeAsync(3000)
    expect(nodes.rows.innerHTML).toContain('No active watches right now.')
  })

  it('does not leave a partially updated frame when an invalid response cannot render', async () => {
    start()
    await flush()
    const previousRows = nodes.rows.innerHTML
    const previousFires = nodes.fires.innerHTML
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ watches: [], recentFires: [null] }) } as Response)
    await vi.advanceTimersByTimeAsync(3000)
    expect(nodes.rows.innerHTML).toBe(previousRows)
    expect(nodes.fires.innerHTML).toBe(previousFires)
    state = { watches: [], recentFires: [] }
    await vi.advanceTimersByTimeAsync(3000)
    expect(nodes.rows.innerHTML).toContain('No active watches right now.')
  })

  it('keeps polls sequential while the preceding request is outstanding', async () => {
    const first = deferred<Response>()
    fetchMock.mockReturnValueOnce(first.promise)
    const dispose = start()
    await vi.advanceTimersByTimeAsync(9000)
    expect(fetchMock).toHaveBeenCalledOnce()
    first.resolve(response(state))
    await flush()
    await vi.advanceTimersByTimeAsync(2999)
    expect(fetchMock).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    dispose()
  })

  it('cancels using encoded original identifiers and refreshes through the existing poll', async () => {
    start()
    await flush()
    const button = nodes.rows.attachButton('session & ?/用户', 'watch&7')
    fetchMock.mockResolvedValueOnce({ ok: true } as Response)
    nodes.rows.click(button)
    nodes.rows.click(button)
    expect(button.disabled).toBe(true)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/plugins/dsh-sentinel/cancel?sessionId=session%20%26%20%3F%2F%E7%94%A8%E6%88%B7&id=watch%267',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    )
    state = { watches: [], recentFires: [] }
    await vi.advanceTimersByTimeAsync(3000)
    expect(nodes.rows.innerHTML).toContain('No active watches right now.')
  })

  it.each(['http', 'network'] as const)('re-enables cancellation after %s failure without treating it as success', async failure => {
    start()
    await flush()
    const previous = nodes.rows.innerHTML
    const button = nodes.rows.attachButton('session-review', 'watch-1')
    if (failure === 'http') fetchMock.mockResolvedValueOnce({ ok: false } as Response)
    else fetchMock.mockRejectedValueOnce(new Error('network unavailable'))
    nodes.rows.click(button)
    expect(button.disabled).toBe(true)
    await flush()
    expect(button.disabled).toBe(false)
    expect(nodes.rows.innerHTML).toBe(previous)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('times out cancellation requests and makes the button available again', async () => {
    start()
    await flush()
    const button = nodes.rows.attachButton('session-review', 'watch-1')
    let signal!: AbortSignal
    fetchMock.mockImplementationOnce(async (_input, init) => {
      signal = init!.signal!
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
    })
    nodes.rows.click(button)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(signal.aborted).toBe(true)
    expect(button.disabled).toBe(false)
  })

  it('does not cancel unrelated, missing-identifier or already disabled buttons', async () => {
    start()
    await flush()
    const unrelated = new FakeButton({ 'data-session': 'other', 'data-id': 'watch-1' })
    nodes.rows.click(unrelated)
    nodes.rows.click(nodes.rows.attachButton('', 'watch-1'))
    const disabled = nodes.rows.attachButton('session-review', 'watch-1')
    disabled.disabled = true
    nodes.rows.click(disabled)
    nodes.rows.emit('click', { target: null })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('pauses on pagehide and resumes after bfcache restoration without duplicate polls', async () => {
    const dispose = start()
    await flush()
    lifecycle.emit('pagehide', { persisted: true })
    await flush()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchMock).toHaveBeenCalledOnce()
    lifecycle.emit('pageshow', { persisted: true })
    lifecycle.emit('pageshow', { persisted: true })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    dispose()
    expect(nodes.rows.listeners.get('click')?.size).toBe(0)
    expect(lifecycle.listeners.get('pagehide')?.size).toBe(0)
    expect(lifecycle.listeners.get('pageshow')?.size).toBe(0)
    lifecycle.emit('pageshow', { persisted: true })
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('aborts requests and ignores responses that finish after disposal', async () => {
    const pending = deferred<Response>()
    fetchMock.mockReturnValueOnce(pending.promise)
    const dispose = start()
    const signal = fetchMock.mock.calls[0]![1]!.signal!
    dispose()
    dispose()
    expect(signal.aborted).toBe(true)
    pending.resolve(response(state))
    await flush()
    expect(nodes.rows.innerHTML).toBe('server-rendered frame')
    expect(nodes.fires.innerHTML).toBe('server-rendered frame')
  })

  it('does not let an old cancellation settle into a new request after page restoration', async () => {
    start()
    await flush()
    const button = nodes.rows.attachButton('session-review', 'watch-1')
    const old = deferred<Response>()
    fetchMock.mockReturnValueOnce(old.promise)
    nodes.rows.click(button)
    const oldSignal = fetchMock.mock.lastCall![1]!.signal!
    lifecycle.emit('pagehide', { persisted: true })
    expect(oldSignal.aborted).toBe(true)
    expect(button.disabled).toBe(false)
    lifecycle.emit('pageshow', { persisted: true })
    await flush()
    const current = deferred<Response>()
    fetchMock.mockReturnValueOnce(current.promise)
    nodes.rows.click(button)
    old.resolve({ ok: false } as Response)
    await flush()
    expect(button.disabled).toBe(true)
    current.resolve({ ok: false } as Response)
    await flush()
    expect(button.disabled).toBe(false)
  })

  it('does nothing when a required server-rendered element is missing', () => {
    vi.stubGlobal('document', { documentElement: { lang: 'en' }, defaultView: lifecycle, getElementById: () => null })
    const dispose = startDashboard()
    dispose()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(lifecycle.listeners.size).toBe(0)
  })
})
