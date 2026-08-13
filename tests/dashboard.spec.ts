import { describe, expect, it } from 'vitest'
import { dashboardHtml, type WatchRow } from '../src/index.ts'

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
    ...overrides,
  }
}

describe('dashboardHtml', () => {
  it('renders the empty state without rows', () => {
    const html = dashboardHtml([])
    expect(html).toContain('当前没有活跃的监控。')
    expect(html).toContain('<tbody id="rows">')
  })

  it('renders one row per watch with budget and cadence cells', () => {
    const html = dashboardHtml([row(), row({ id: 'watch-2', kind: 'webhook' })])
    expect(html).toContain('watch-1')
    expect(html).toContain('watch-2')
    expect(html).toContain('0/1')
    expect(html).toContain('即时推送')
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
})
