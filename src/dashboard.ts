import type { WatchRow } from './index.ts'
import { createPresentation, localizeState as stateLabel, messages, type FireMessage, type Locale } from './locale.ts'

const STATE_PATH = '/plugins/dsh-sentinel/state'
const CANCEL_PATH = '/plugins/dsh-sentinel/cancel'

const en = {
  title: 'Sentinel overview',
  heads: ['Session', 'Watch', 'Sensor', 'Target', 'Pattern', 'Fires', 'Last state', 'Next probe', ''],
  fireHeads: ['Time', 'Watch', 'Session', 'Summary'],
  empty: 'No active watches right now.',
  firesTitle: 'Recent fires',
  firesEmpty: 'No fires yet.',
  live: 'live', dormant: 'dormant', probing: 'probing', push: 'live push',
  cancel: 'Cancel this watch', pending: '{n} pending', dropped: '{n} dropped',
  count: '{n} watch(es)', duty: 'duty heartbeat {age}s ago',
  dutyStale: 'duty heartbeat stale ({age}s ago)', dutyNone: 'no resident duty process',
}
const zh: typeof en = {
  title: 'Sentinel 全局总览',
  heads: ['会话', '监控', '传感器', '目标', '模式', '触发', '最近状态', '下次探测', ''],
  fireHeads: ['时间', '监控', '会话', '摘要'],
  empty: '当前没有活跃的监控。', firesTitle: '最近触发', firesEmpty: '尚未触发过。',
  live: '活跃', dormant: '休眠', probing: '探测中', push: '即时推送',
  cancel: '取消这个监控', pending: '待投递 {n}', dropped: '已丢弃 {n} 唤醒',
  count: '{n} 个监控', duty: '值守心跳 {age}s 前',
  dutyStale: '值守心跳 {age}s 前（疑似停摆）', dutyNone: '无常驻值守进程',
}
const dictionaries = { en, zh }
type DashboardCopy = typeof en
export type DashboardFire = FireMessage & { sessionId: string; id: string; at: string }

/** Retain the original public boolean helper while using shared presentation rules. */
export function localizeState(state: string, zh: boolean): string {
  return stateLabel(state, zh ? 'zh' : 'en')
}

/**
 * One closure-free renderer serves SSR and refreshes. All dependencies are arguments
 * or nested functions: serializing this factory remains safe after bundle renaming.
 */
function createDashboardRenderer(locale: Locale, copy: DashboardCopy, presentation: ReturnType<typeof createPresentation>) {
  const escapeHtml = (value: unknown): string => String(value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
  const fill = (template: string, values: Record<string, unknown>): string => template.replace(/\{(\w+)\}/g,
    (token, key: string) => values[key] === undefined ? token : String(values[key]))
  const { localizeState: state, formatFireSummary: summary } = presentation
  const time = (value?: string): string => (value === undefined ? new Date() : new Date(value))
    .toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en')
  const rows = (watches: readonly WatchRow[], dropped: Readonly<Record<string, number>> = {}): string => {
    if (watches.length === 0) return `<tr><td colspan="9" class="empty">${escapeHtml(copy.empty)}</td></tr>`
    return watches.map(row => {
      const lost = dropped[row.sessionId] ?? 0
      const droppedBadge = lost > 0 ? ` <small class="dropped">${escapeHtml(fill(copy.dropped, { n: lost }))}</small>` : ''
      const session = `${escapeHtml(row.sessionId.slice(0, 16))}… <small>${escapeHtml(row.live ? copy.live : copy.dormant)}</small>${droppedBadge}`
      const pattern = row.pattern !== undefined ? `<code>/${escapeHtml(row.pattern)}/</code>` : '—'
      const lastState = row.lastState !== undefined ? state(row.lastState) : copy.probing
      const next = row.kind === 'webhook' ? copy.push
        : row.nextDueAt !== undefined ? `${String(Math.max(0, Math.ceil((row.nextDueAt - Date.now()) / 1000)))}s` : '…'
      const pending = row.pendingWakeups > 0 ? ` <small class="pending">${escapeHtml(fill(copy.pending, { n: row.pendingWakeups }))}</small>` : ''
      return `<tr><td>${session}</td><td>${escapeHtml(row.id)}</td><td>${escapeHtml(row.kind)}</td>`
        + `<td class="target" title="${escapeHtml(row.note)}">${escapeHtml(row.target)}</td><td>${pattern}</td>`
        + `<td>${String(row.fireCount)}/${String(row.maxFires)}${pending}</td><td>${escapeHtml(lastState)}</td><td>${escapeHtml(next)}</td>`
        + `<td><button type="button" class="cancel" data-session="${escapeHtml(row.sessionId)}" data-id="${escapeHtml(row.id)}"`
        + ` title="${escapeHtml(copy.cancel)}" aria-label="${escapeHtml(copy.cancel)} ${escapeHtml(row.id)}">×</button></td></tr>`
    }).join('')
  }
  const fires = (facts: readonly DashboardFire[]): string => facts.length === 0
    ? `<tr><td colspan="4" class="empty">${escapeHtml(copy.firesEmpty)}</td></tr>`
    : facts.map(fire => `<tr><td>${escapeHtml(time(fire.at))}</td><td>${escapeHtml(fire.id)}</td>`
      + `<td>${escapeHtml(fire.sessionId.slice(0, 16))}…</td><td class="target">${escapeHtml(summary(fire))}</td></tr>`).join('')
  const meta = (count: number, duty?: { ageMs: number; stale: boolean } | null): string => {
    const dutyText = duty == null ? copy.dutyNone
      : fill(duty.stale ? copy.dutyStale : copy.duty, { age: Math.max(0, Math.round(duty.ageMs / 1000)) })
    return `· ${fill(copy.count, { n: count })} · ${dutyText} · ${time()}`
  }
  return { escapeHtml, rows, fires, meta, state, summary }
}

/** JSON inside executable HTML must not let values terminate the script element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
}

/** Server and refresh rendering retain one selected locale for the page lifetime. */
export function dashboardHtml(
  rows: readonly WatchRow[],
  fires: readonly DashboardFire[] = [],
  dropped: Readonly<Record<string, number>> = {},
  locale: Locale = 'en',
): string {
  const copy = dictionaries[locale]
  const render = createDashboardRenderer(locale, copy, createPresentation(locale, messages[locale]))
  return `<!doctype html>
<html lang="${locale === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${render.escapeHtml(copy.title)}</title>
<style>
  :root { --s-bg: #ffffff; --s-fg: #1f2329; --s-muted: #86909c; --s-border: #e5e6eb; --s-code: #f2f3f5; }
  @media (prefers-color-scheme: dark) { :root { --s-bg: #17181c; --s-fg: #e3e4e8; --s-muted: #8a8f99; --s-border: #33353c; --s-code: #24262c; } }
  body { font-family: system-ui, sans-serif; margin: 24px; color: var(--s-fg); background: var(--s-bg); }
  h1 { font-size: 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border-bottom: 1px solid var(--s-border); padding: 6px 10px; text-align: left; vertical-align: top; }
  th { color: var(--s-muted); font-weight: 500; white-space: nowrap; }
  td.target { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.empty { color: var(--s-muted); text-align: center; padding: 24px; }
  code { background: var(--s-code); padding: 1px 4px; border-radius: 4px; }
  small { color: var(--s-muted); }
  small.pending { color: #d4a72c; }
  small.dropped { color: #e5484d; }
  h2 { font-size: 13px; color: var(--s-muted); font-weight: 500; margin: 18px 0 6px; }
  .cancel { border: none; background: transparent; color: var(--s-muted); cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 6px; border-radius: 4px; }
  .cancel:hover { color: #e5484d; background: rgba(229, 72, 77, .1); }
</style>
</head>
<body>
<h1><span id="title">👁 ${render.escapeHtml(copy.title)}</span> <small id="meta"></small></h1>
<table>
<thead><tr>${copy.heads.map(head => `<th>${render.escapeHtml(head)}</th>`).join('')}</tr></thead>
<tbody id="rows">${render.rows(rows, dropped)}</tbody>
</table>
<h2 id="firesTitle">${render.escapeHtml(copy.firesTitle)}</h2>
<table>
<thead><tr>${copy.fireHeads.map(head => `<th>${render.escapeHtml(head)}</th>`).join('')}</tr></thead>
<tbody id="fires">${render.fires(fires)}</tbody>
</table>
<script>
const presentation = (${createPresentation.toString()})(${scriptJson(locale)}, ${scriptJson(messages[locale])})
const renderer = (${createDashboardRenderer.toString()})(${scriptJson(locale)}, ${scriptJson(copy)}, presentation)
const ROWS = document.getElementById('rows')
const FIRES = document.getElementById('fires')
const META = document.getElementById('meta')
const CANCEL_URL = ${scriptJson(CANCEL_PATH)}
ROWS.addEventListener('click', (event) => {
  const button = event.target && event.target.closest ? event.target.closest('.cancel') : null
  if (button === null) return
  const sessionId = button.getAttribute('data-session')
  const id = button.getAttribute('data-id')
  if (sessionId === null || id === null) return
  button.disabled = true
  void fetch(CANCEL_URL + '?sessionId=' + encodeURIComponent(sessionId) + '&id=' + encodeURIComponent(id), { method: 'POST' })
    .then(() => refresh(), () => { button.disabled = false })
})
const refresh = async () => {
  try {
    const response = await fetch(${scriptJson(STATE_PATH)}, { headers: { accept: 'application/json' } })
    if (!response.ok) return
    const data = await response.json()
    const watches = Array.isArray(data.watches) ? data.watches : []
    ROWS.innerHTML = renderer.rows(watches, data.droppedWakeups || {})
    FIRES.innerHTML = renderer.fires(Array.isArray(data.recentFires) ? data.recentFires : [])
    META.textContent = renderer.meta(watches.length, data.duty)
  } catch {}
}
refresh()
setInterval(refresh, 3000)
</script>
</body>
</html>
`
}
