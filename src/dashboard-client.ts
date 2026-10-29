import { createPoller, DEFAULT_POLL_TIMEOUT_MS } from './client/poller.ts'
import { createDashboardRenderer, type DashboardState } from './dashboard-view.ts'
import { resolveLocale } from './locale.ts'

const STATE_PATH = '/plugins/dsh-sentinel/state'
const CANCEL_PATH = '/plugins/dsh-sentinel/cancel'
const POLL_MS = 3000

/** Start the standalone page after its deferred script loads; the server owns its language. */
export function startDashboard(): () => void {
  const rows = document.getElementById('rows')
  const fires = document.getElementById('fires')
  const meta = document.getElementById('meta')
  if (rows === null || fires === null || meta === null) return () => {}

  const renderer = createDashboardRenderer(resolveLocale(document.documentElement.lang))
  const lifecycle = document.defaultView
  const cancellations = new Map<HTMLButtonElement, { controller: AbortController; timer: ReturnType<typeof setTimeout> }>()
  let disposed = false
  let paused = false
  const poller = createPoller({
    intervalMs: POLL_MS,
    run: async signal => {
      const response = await fetch(STATE_PATH, { headers: { accept: 'application/json' }, signal })
      if (!response.ok || signal.aborted || disposed || paused) return
      const data = await response.json() as Partial<DashboardState>
      if (signal.aborted || disposed || paused) return
      const watches = Array.isArray(data.watches) ? data.watches : []
      const nextRows = renderer.rows(watches, data.droppedWakeups ?? {})
      const nextFires = renderer.fires(Array.isArray(data.recentFires) ? data.recentFires : [])
      const nextMeta = renderer.meta(watches.length, data.duty)
      rows.innerHTML = nextRows
      fires.innerHTML = nextFires
      meta.textContent = nextMeta
    },
    // Preserve the previous frame on transient failures; the next serialized poll retries.
    onError: () => {},
  })

  const cancel = async (button: HTMLButtonElement, sessionId: string, id: string): Promise<void> => {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, DEFAULT_POLL_TIMEOUT_MS)
    cancellations.set(button, { controller, timer })
    button.disabled = true
    let succeeded = false
    try {
      const response = await fetch(`${CANCEL_PATH}?sessionId=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(id)}`, {
        method: 'POST', signal: controller.signal,
      })
      succeeded = response.ok && !controller.signal.aborted && !disposed && !paused
      // The existing serialized poll refreshes rows within POLL_MS after it settles.
      // Do not add a concurrent GET merely to refresh after cancellation.
    } catch {
      // Network failures and aborts leave the action available for retry.
    } finally {
      clearTimeout(timer)
      if (cancellations.get(button)?.controller === controller) {
        cancellations.delete(button)
        if (!succeeded) button.disabled = false
      }
    }
  }

  const onClick = (event: Event): void => {
    const target = event.target as Element | null
    if (disposed || paused || typeof target?.closest !== 'function') return
    const button = target.closest<HTMLButtonElement>('button.cancel')
    if (button === null || !rows.contains(button) || button.disabled) return
    const sessionId = button.getAttribute('data-session')
    const id = button.getAttribute('data-id')
    if (sessionId === null || id === null || sessionId === '' || id === '') return
    void cancel(button, sessionId, id)
  }

  const pause = (): void => {
    paused = true
    poller.stop()
    for (const [button, request] of cancellations) {
      clearTimeout(request.timer)
      request.controller.abort()
      button.disabled = false
    }
    cancellations.clear()
  }
  const resume = (): void => {
    if (disposed) return
    paused = false
    poller.start()
  }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    pause()
    rows.removeEventListener('click', onClick)
    lifecycle?.removeEventListener('pagehide', pause)
    lifecycle?.removeEventListener('pageshow', resume)
  }

  rows.addEventListener('click', onClick)
  lifecycle?.addEventListener('pagehide', pause)
  lifecycle?.addEventListener('pageshow', resume)
  poller.start()
  return dispose
}

if (typeof document !== 'undefined') startDashboard()
