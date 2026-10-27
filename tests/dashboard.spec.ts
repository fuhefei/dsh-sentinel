import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { dashboardHtml, localizeState } from '../src/dashboard.ts'
import type { WatchRow } from '../src/index.ts'
import type { Locale } from '../src/locale.ts'

function row(overrides: Partial<WatchRow> = {}): WatchRow {
  return {
    sessionId: 'session-00000000-0000-0000-0000-000000000000',
    live: true,
    id: 'watch-1',
    kind: 'file',
    target: '/tmp/a.txt',
    intervalSeconds: 30,
    note: 'watch note',
    fireCount: 0,
    maxFires: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    pendingWakeups: 0,
    ...overrides,
  }
}

interface FakeElement {
  innerHTML: string
  textContent: string
  listeners: Record<string, (event: unknown) => void>
  addEventListener(type: string, listener: (event: unknown) => void): void
}

/** Execute the real emitted script without React, a DOM package, or hidden closures. */
async function executeDashboard(html: string, data: Record<string, unknown>, browserLanguage = 'zh-CN') {
  const elements: Record<string, FakeElement> = {}
  for (const id of ['rows', 'fires', 'meta', 'title', 'firesTitle']) {
    elements[id] = {
      innerHTML: '', textContent: '', listeners: {},
      addEventListener(type, listener) { this.listeners[type] = listener },
    }
  }
  const calls: Array<{ url: string; options: Record<string, unknown> }> = []
  const context = createContext({
    document: { getElementById: (id: string) => elements[id] },
    navigator: { language: browserLanguage },
    fetch: async (url: string, options: Record<string, unknown>) => {
      calls.push({ url, options })
      return { ok: true, json: async () => data }
    },
    setInterval: () => 1,
  })
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1]
  if (script === undefined) throw new Error('Dashboard script missing')
  runInContext(script, context)
  await runInContext('refresh()', context)
  return { elements, calls, context }
}

function initialHtml(html: string): string { return html.split('<script>')[0]! }

describe('dashboardHtml', () => {
  it('renders English consistently before JavaScript runs', () => {
    const initial = initialHtml(dashboardHtml([]))
    expect(initial).toContain('<html lang="en">')
    expect(initial).toContain('<title>Sentinel overview</title>')
    expect(initial).toContain('<th>Time</th><th>Watch</th><th>Session</th><th>Summary</th>')
    expect(initial).toContain('No active watches right now.')
    expect(initial).not.toMatch(/\p{Script=Han}/u)
  })

  it('renders Chinese consistently before JavaScript runs when requested', () => {
    const initial = initialHtml(dashboardHtml([], [], {}, 'zh'))
    expect(initial).toContain('<html lang="zh-CN">')
    expect(initial).toContain('<title>Sentinel 全局总览</title>')
    expect(initial).toContain('<th>时间</th><th>监控</th><th>会话</th><th>摘要</th>')
    expect(initial).toContain('当前没有活跃的监控。')
    expect(initial).toContain('<tbody id="rows">')
  })

  it('renders one row per watch with budget and cadence cells', () => {
    const html = dashboardHtml([row(), row({ id: 'watch-2', kind: 'webhook' })], [], {}, 'zh')
    expect(html).toContain('watch-1')
    expect(html).toContain('watch-2')
    expect(html).toContain('0/1')
    expect(html).toContain('即时推送')
  })

  it('renders a manual cancel button and pending badge per row', () => {
    const html = dashboardHtml([row({ pendingWakeups: 2 })], [], {}, 'zh')
    expect(html).toContain('class="cancel"')
    expect(html).toContain('data-id="watch-1"')
    expect(html).toContain('<small class="pending">待投递 2</small>')
    const quiet = dashboardHtml([row()], [], {}, 'zh')
    expect(quiet).not.toContain('>待投递')
  })

  it('escapes the session id inside the cancel button attributes', () => {
    const html = dashboardHtml([row({ sessionId: '"><img src=x onerror=alert(1)>' })])
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('data-session="&quot;&gt;&lt;img')
  })

  it('renders recent fires and dropped-wakeup badges with escaping', () => {
    const html = dashboardHtml(
      [row()],
      [{ sessionId: row().sessionId, id: 'watch-1', at: '2026-01-01T00:00:00.000Z', summary: '模式 /x/ 开始匹配: <b>y</b>' }],
      { [row().sessionId]: 3 },
      'zh',
    )
    expect(html).toContain('<h2 id="firesTitle">最近触发</h2>')
    expect(html).toContain('&lt;b&gt;y&lt;/b&gt;')
    expect(html).toContain('已丢弃 3 唤醒')
  })

  it('renders the empty fires state and no badge by default', () => {
    const html = dashboardHtml([row()], [], {}, 'zh')
    expect(html).toContain('尚未触发过。')
    expect(html).not.toContain('>已丢弃')
  })

  it('escapes user-controlled fields so watch input cannot inject markup', () => {
    const html = dashboardHtml([row({
      target: '"><script>alert(1)</script>',
      note: '\'><img src=x onerror=alert(1)>',
      pattern: '<b>bold</b>',
    })])
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<b>bold</b>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it.each(['en', 'zh'] as const)('executes refresh in %s without changing the selected language', async (locale: Locale) => {
    const watch = row({ pendingWakeups: 2, lastState: 'absent', kind: 'webhook' })
    const fire = {
      sessionId: watch.sessionId, id: 'watch-1', at: '2026-01-01T00:00:00.000Z',
      summary: 'canonical fallback', trigger: { kind: 'change' as const }, state: 'absent',
    }
    const html = dashboardHtml([watch], [fire], { [watch.sessionId]: 3 }, locale)
    const initial = initialHtml(html)
    const { elements } = await executeDashboard(html, {
      watches: [watch], recentFires: [fire], droppedWakeups: { [watch.sessionId]: 3 }, duty: { ageMs: 12_000, stale: true },
    }, locale === 'en' ? 'zh-CN' : 'en-US')
    const english = locale === 'en'
    expect(initial).toContain(english ? '<th>Time</th><th>Watch</th><th>Session</th><th>Summary</th>' : '<th>时间</th><th>监控</th><th>会话</th><th>摘要</th>')
    expect(elements.rows!.innerHTML).toContain(english ? '<td>absent</td>' : '<td>不存在</td>')
    expect(elements.rows!.innerHTML).toContain(english ? '2 pending' : '待投递 2')
    expect(elements.rows!.innerHTML).toContain(english ? '3 dropped' : '已丢弃 3 唤醒')
    expect(elements.rows!.innerHTML).toContain(english ? 'live push' : '即时推送')
    expect(elements.rows!.innerHTML).toContain(english ? 'aria-label="Cancel this watch watch-1"' : 'aria-label="取消这个监控 watch-1"')
    expect(elements.fires!.innerHTML).toContain(english ? 'Snapshot changed (state: absent)' : '快照发生变化（状态: 不存在）')
    expect(elements.meta!.textContent).toContain(english ? 'duty heartbeat stale (12s ago)' : '值守心跳 12s 前（疑似停摆）')
    expect(initial).toContain(elements.rows!.innerHTML)
    expect(initial).toContain(elements.fires!.innerHTML)
  })

  it.each(['en', 'zh'] as const)('refreshes empty and missing-duty states in %s', async (locale: Locale) => {
    const { elements } = await executeDashboard(dashboardHtml([], [], {}, locale), {})
    expect(elements.rows!.innerHTML).toContain(locale === 'en' ? 'No active watches right now.' : '当前没有活跃的监控。')
    expect(elements.fires!.innerHTML).toContain(locale === 'en' ? 'No fires yet.' : '尚未触发过。')
    expect(elements.meta!.textContent).toContain(locale === 'en' ? 'no resident duty process' : '无常驻值守进程')
  })

  it('escapes refreshed fields and translates only plugin-owned fire text', async () => {
    const watch = row({
      sessionId: '"><img src=x onerror=alert(1)>', id: 'watch-<1>', target: '</script><b>target</b>',
      note: '\" onclick=\"alert(1)', pattern: '<pattern>', lastState: '<unknown>',
    })
    const { elements } = await executeDashboard(dashboardHtml([]), {
      watches: [watch],
      recentFires: [{
        sessionId: watch.sessionId, id: watch.id, at: '2026-01-01T00:00:00.000Z',
        summary: '模式 /<pattern>/ 开始匹配: <b>match</b>',
      }, { sessionId: 'session', id: 'custom', at: '2026-01-01T00:00:00.000Z', summary: '用户原文 <custom>' }],
    })
    const rendered = elements.rows!.innerHTML + elements.fires!.innerHTML
    expect(rendered).not.toContain('<img')
    expect(rendered).not.toContain('</script>')
    expect(rendered).not.toContain('<b>')
    expect(rendered).toContain('&lt;/script&gt;&lt;b&gt;target&lt;/b&gt;')
    expect(rendered).toContain('&lt;unknown&gt;')
    expect(rendered).toContain('Pattern /&lt;pattern&gt;/ started matching: &lt;b&gt;match&lt;/b&gt;')
    expect(rendered).toContain('用户原文 &lt;custom&gt;')
  })

  it('keeps manual cancel wired to the original session and watch identifiers', async () => {
    const { elements, calls } = await executeDashboard(dashboardHtml([]), {})
    const button = { disabled: false, getAttribute: (name: string) => name === 'data-session' ? 'session & 1' : 'watch-1' }
    elements.rows!.listeners.click!({ target: { closest: () => button } })
    await Promise.resolve()
    expect(calls).toContainEqual({
      url: '/plugins/dsh-sentinel/cancel?sessionId=session%20%26%201&id=watch-1', options: { method: 'POST' },
    })
    expect(button.disabled).toBe(true)
  })
})

describe('localizeState', () => {
  it('maps sensor state words to Chinese and passes English through', () => {
    expect(localizeState('absent', true)).toBe('不存在')
    expect(localizeState('exists (12 bytes)', true)).toBe('存在（12 字节）')
    expect(localizeState('exit 2', true)).toBe('退出码 2')
    expect(localizeState('unreachable', true)).toBe('不可达')
    expect(localizeState('no process', true)).toBe('无进程')
    expect(localizeState('3 process(es)', true)).toBe('3 个进程')
    expect(localizeState('open (db:5432)', true)).toBe('端口可达 (db:5432)')
    expect(localizeState('closed (db:5432)', true)).toBe('端口不通 (db:5432)')
    expect(localizeState('timeout (db:5432)', true)).toBe('探测超时 (db:5432)')
    expect(localizeState('awaiting push', true)).toBe('等待推送')
    expect(localizeState('HTTP 200', true)).toBe('HTTP 200')
    expect(localizeState('exit 2', false)).toBe('exit 2')
  })
})
