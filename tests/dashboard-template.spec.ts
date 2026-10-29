import Mustache, { type TemplateSpans } from 'mustache'
import { describe, expect, it } from 'vitest'
import { dashboardHtml } from '../src/dashboard.ts'
import { createDashboardRenderer, dashboardPartials } from '../src/dashboard-view.ts'
import type { WatchRow } from '../src/index.ts'
import pageTemplate from '../templates/dashboard.html?raw'
import documentTemplate from '../templates/layouts/document.html?raw'

const partials = { dashboard: pageTemplate, ...dashboardPartials }

function watch(overrides: Partial<WatchRow> = {}): WatchRow {
  return {
    sessionId: 'session-template', live: true, id: 'watch-1', kind: 'file', target: '/tmp/ready',
    intervalSeconds: 30, note: '', fireCount: 0, maxFires: 1, pendingWakeups: 0,
    createdAt: '2026-01-01T00:00:00Z', ...overrides,
  }
}

function checkTokens(tokens: TemplateSpans): void {
  for (const token of tokens) {
    expect(token[0]).not.toBe('&')
    expect(token[0]).not.toBe('=')
    if (token[0] === '>') expect(Object.hasOwn(partials, token[1])).toBe(true)
    if (Array.isArray(token[4])) checkTokens(token[4])
  }
}

describe('dashboard Mustache templates', () => {
  it('uses escaped variables and a static partial registry without raw HTML slots', () => {
    for (const template of [documentTemplate, ...Object.values(partials)]) checkTokens(Mustache.parse(template))
  })

  it.each(['en', 'zh'] as const)('preserves literal caller data in text and attributes in %s', locale => {
    const value = '{{title}} {{{value}}} {{>watch}} {{#x}} <!-- sentinel:rows --> $& <img src=x> & " \' / = `'
    const escaped = Mustache.escape(value)
    const row = watch({ sessionId: value, id: value, note: value, target: value, pattern: value, lastState: value })
    const fire = { sessionId: value, id: value, at: '2026-01-01T00:00:00Z', summary: value }
    const renderer = createDashboardRenderer(locale)
    const rows = renderer.rows([row])
    const fires = renderer.fires([fire])
    expect(rows).toContain(`data-session="${escaped}"`)
    expect(rows).toContain(`data-id="${escaped}"`)
    expect(rows).toContain(`title="${escaped}"`)
    expect(rows).toContain(`<code>/${escaped}/</code>`)
    expect(fires).toContain(escaped)
    for (const html of [rows, fires]) {
      expect(html).not.toContain('<img src=x>')
      expect(html).not.toContain('<!-- sentinel:rows -->')
      expect(html).toContain('&#x2F; &#x3D; &#x60;')
    }
    const page = dashboardHtml([row], [fire], {}, locale)
    expect(page).toContain(rows)
    expect(page).toContain(fires)
  })

  it.each([
    { pattern: undefined, expected: '<td>—</td>' },
    { pattern: '', expected: '<code>//</code>' },
    { pattern: 'READY', expected: '<code>/READY/</code>' },
  ])('distinguishes omitted and empty regexes: $pattern', ({ pattern, expected }) => {
    expect(createDashboardRenderer('en').rows([watch({ pattern })])).toContain(expected)
  })

  it('preserves zero counts, empty strings, dormant state and a zero due timestamp', () => {
    const html = createDashboardRenderer('en').rows([watch({
      sessionId: '', id: '', note: '', target: '', live: false, lastState: '', nextDueAt: 0,
      fireCount: 0, maxFires: 0, pendingWakeups: 0,
    })])
    expect(html).toContain('<small>dormant</small>')
    expect(html).toContain('<td>0/0</td>')
    expect(html).toContain('<td>0s</td>')
    expect(html).toContain('data-session="" data-id=""')
    expect(html).toContain('title=""')
    expect(html).not.toContain('probing')
    expect(html).not.toContain('class="pending"')
  })

  it('renders optional badges only for positive counts and uses plain data models', () => {
    const renderer = createDashboardRenderer('en')
    for (const count of [0, -1]) {
      const html = renderer.rows([watch({ pendingWakeups: count })], { 'session-template': count })
      expect(html).not.toContain('class="pending"')
      expect(html).not.toContain('class="dropped"')
    }
    const model = renderer.watchModel([watch({ pendingWakeups: 2 })], { 'session-template': 3 })
    expect(model).toEqual(JSON.parse(JSON.stringify(model)))
    const html = renderer.rows([watch({ pendingWakeups: 2 })], { 'session-template': 3 })
    expect(html).toContain('<small class="pending">2 pending</small>')
    expect(html).toContain('<small class="dropped">3 dropped</small>')
  })

  it('keeps all table headers, the empty action header and correct empty-state colspans', () => {
    const html = dashboardHtml([])
    const headers = [...html.matchAll(/<thead><tr>([\s\S]*?)<\/tr><\/thead>/g)].map(match => match[1]!)
    expect(headers).toHaveLength(2)
    expect(headers[0]!.match(/<th>/g)).toHaveLength(9)
    expect(headers[0]).toContain('<th></th>')
    expect(headers[1]!.match(/<th>/g)).toHaveLength(4)
    expect(html).toContain('colspan="9" class="empty"')
    expect(html).toContain('colspan="4" class="empty"')
  })
})
