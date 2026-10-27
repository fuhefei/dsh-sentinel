import { readFileSync } from 'node:fs'
import Mustache from 'mustache'
import { describe, expect, it } from 'vitest'
import { dashboardHtml, DASHBOARD_SCRIPT_PATH, DASHBOARD_STYLE_PATH, DASHBOARD_ICON_PATH, localizeState } from '../src/dashboard.ts'
import type { WatchRow } from '../src/index.ts'

function row(overrides: Partial<WatchRow> = {}): WatchRow {
  return {
    sessionId: 'session-00000000-0000-0000-0000-000000000000', live: true, id: 'watch-1',
    kind: 'file', target: '/tmp/a.txt', intervalSeconds: 30, note: 'watch note', fireCount: 0,
    maxFires: 1, createdAt: '2026-01-01T00:00:00.000Z', pendingWakeups: 0,
    ...overrides,
  }
}

describe('dashboardHtml', () => {
  it('renders English consistently before JavaScript runs', () => {
    const html = dashboardHtml([])
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('<title>Sentinel overview</title>')
    expect(html).toContain('<th>Time</th><th>Watch</th><th>Session</th><th>Summary</th>')
    expect(html).toContain('No active watches right now.')
    expect(html).not.toMatch(/\p{Script=Han}/u)
  })

  it('renders Chinese consistently before JavaScript runs when requested', () => {
    const html = dashboardHtml([], [], {}, 'zh')
    expect(html).toContain('<html lang="zh-CN">')
    expect(html).toContain('<title>Sentinel 全局总览</title>')
    expect(html).toContain('<th>时间</th><th>监控</th><th>会话</th><th>摘要</th>')
    expect(html).toContain('当前没有活跃的监控。')
    expect(html).toContain('<tbody id="rows">')
  })

  it.each([
    ['en', 'Active watches', 'Recent fires'], ['zh', '活跃监控', '最近触发'],
  ] as const)('contains wide tables in labeled keyboard-focusable scroll regions in %s', (locale, watches, fires) => {
    const html = dashboardHtml([row({ target: '/tmp/' + 'long-path-'.repeat(50) })], [], {}, locale)
    expect(html).toContain(`class="table-scroll" role="region" aria-label="${watches}" tabindex="0"`)
    expect(html).toContain(`class="table-scroll" role="region" aria-label="${fires}" tabindex="0"`)
    expect(html.match(/class="table-scroll"/g)).toHaveLength(2)
    const css = readFileSync(new URL('../src/dashboard.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.table-scroll\s*\{[^}]*max-width:\s*100%[^}]*overflow-x:\s*auto/)
    expect(html).toContain('data-id="watch-1"')
  })

  it('composes the document layout and dashboard with external styles and a package icon', () => {
    const html = dashboardHtml([])
    expect(html.match(/<!doctype html>/g)).toHaveLength(1)
    expect(html.match(/<main>/g)).toHaveLength(1)
    expect(html).toContain(`<link rel="stylesheet" href="${Mustache.escape(DASHBOARD_STYLE_PATH)}">`)
    expect(html).toContain(`<link rel="icon" type="image/svg+xml" href="${Mustache.escape(DASHBOARD_ICON_PATH)}">`)
    expect(html).not.toMatch(/<style\b|\sstyle=/)
  })

  it('loads only the standalone deferred browser asset, with no executable inline script', () => {
    const html = dashboardHtml([])
    expect(html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g)).toEqual([
      `<script src="${Mustache.escape(DASHBOARD_SCRIPT_PATH)}" defer></script>`,
    ])
    expect(html).not.toContain('const presentation')
    expect(html).not.toContain('setInterval(')
    expect(html).not.toContain('window.__DSH_BOOT__')
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
    expect(dashboardHtml([row()], [], {}, 'zh')).not.toContain('>待投递')
  })

  it('escapes the session id inside the cancel button attributes', () => {
    const html = dashboardHtml([row({ sessionId: '\"><img src=x onerror=alert(1)>' })])
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('data-session="&quot;&gt;&lt;img')
  })

  it('renders recent fires and dropped-wakeup badges with escaping', () => {
    const html = dashboardHtml([row()], [{
      sessionId: row().sessionId, id: 'watch-1', at: '2026-01-01T00:00:00.000Z', summary: '模式 /x/ 开始匹配: <b>y</b>',
    }], { [row().sessionId]: 3 }, 'zh')
    expect(html).toContain('<h2 id="firesTitle">最近触发</h2>')
    expect(html).toContain(Mustache.escape('<b>y</b>'))
    expect(html).toContain('已丢弃 3 唤醒')
  })

  it('renders the empty fires state and no badge by default', () => {
    const html = dashboardHtml([row()], [], {}, 'zh')
    expect(html).toContain('尚未触发过。')
    expect(html).not.toContain('>已丢弃')
  })

  it('escapes user-controlled fields so watch input cannot inject markup', () => {
    const html = dashboardHtml([row({
      target: '\"><script>alert(1)</script>', note: '\'><img src=x onerror=alert(1)>', pattern: '<b>bold</b>',
    })])
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<b>bold</b>')
    expect(html).toContain(Mustache.escape('<script>alert(1)</script>'))
  })

  it('does not reinterpret template markers or replacement tokens inside caller text', () => {
    const value = '{{title}} <!-- sentinel:watches --> $& " <img>'
    const html = dashboardHtml([row({ target: value, note: value, pattern: value })])
    expect(html).toContain('{{title}} &lt;!-- sentinel:watches --&gt; $&amp; &quot; &lt;img&gt;')
    expect(html).not.toContain('<img>')
    expect(html).not.toContain('<!-- sentinel:watches -->')
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
