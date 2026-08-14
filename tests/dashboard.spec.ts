import { describe, expect, it } from 'vitest'
import { dashboardHtml, localizeState, type WatchRow } from '../src/index.ts'

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

  it('renders a manual cancel button and pending badge per row', () => {
    const html = dashboardHtml([row({ pendingWakeups: 2 })])
    expect(html).toContain('class="cancel"')
    expect(html).toContain('data-id="watch-1"')
    expect(html).toContain('<small class="pending">待投递 2</small>')
    const quiet = dashboardHtml([row()])
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
      [{ sessionId: 'session-00000000-0000-0000-0000-000000000000', id: 'watch-1', at: '2026-01-01T00:00:00.000Z', summary: '模式 /x/ 开始匹配: <b>y</b>' }],
      { 'session-00000000-0000-0000-0000-000000000000': 3 },
    )
    expect(html).toContain('<h2 id="firesTitle">最近触发</h2>')
    expect(html).toContain('&lt;b&gt;y&lt;/b&gt;')
    expect(html).toContain('已丢弃 3 唤醒')
  })

  it('renders the empty fires state and no badge by default', () => {
    const html = dashboardHtml([row()])
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

  it('embeds the bilingual switch script', () => {
    const html = dashboardHtml([])
    expect(html).toContain('navigator.language')
    expect(html).toContain('localizeState')
  })
})

describe('localizeState', () => {
  it('maps sensor state words to Chinese and passes English through', () => {
    expect(localizeState('absent', true)).toBe('不存在')
    expect(localizeState('exists (12 bytes)', true)).toBe('存在 (12 bytes)')
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
