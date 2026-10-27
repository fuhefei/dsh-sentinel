import type { WatchRow } from './index.ts'
import { createPresentation, messages, type FireMessage, type Locale } from './locale.ts'
import { joinHtml, renderTemplate, type RenderedHtml } from './dashboard-template.ts'
import watchTemplate from '../templates/dashboard-watch.html?raw'
import fireTemplate from '../templates/dashboard-fire.html?raw'
import emptyTemplate from '../templates/dashboard-empty.html?raw'
import headingTemplate from '../templates/dashboard-heading.html?raw'
import badgeTemplate from '../templates/dashboard-badge.html?raw'
import patternTemplate from '../templates/dashboard-pattern.html?raw'

const en = {
  title: 'Sentinel overview', watchesTitle: 'Active watches',
  heads: ['Session', 'Watch', 'Sensor', 'Target', 'Pattern', 'Fires', 'Last state', 'Next probe', ''],
  fireHeads: ['Time', 'Watch', 'Session', 'Summary'],
  empty: 'No active watches right now.', firesTitle: 'Recent fires', firesEmpty: 'No fires yet.',
  live: 'live', dormant: 'dormant', probing: 'probing', push: 'live push',
  cancel: 'Cancel this watch', pending: '{n} pending', dropped: '{n} dropped',
  count: '{n} watch(es)', duty: 'duty heartbeat {age}s ago',
  dutyStale: 'duty heartbeat stale ({age}s ago)', dutyNone: 'no resident duty process',
}
const zh: typeof en = {
  title: 'Sentinel 全局总览', watchesTitle: '活跃监控',
  heads: ['会话', '监控', '传感器', '目标', '模式', '触发', '最近状态', '下次探测', ''],
  fireHeads: ['时间', '监控', '会话', '摘要'],
  empty: '当前没有活跃的监控。', firesTitle: '最近触发', firesEmpty: '尚未触发过。',
  live: '活跃', dormant: '休眠', probing: '探测中', push: '即时推送',
  cancel: '取消这个监控', pending: '待投递 {n}', dropped: '已丢弃 {n} 唤醒',
  count: '{n} 个监控', duty: '值守心跳 {age}s 前',
  dutyStale: '值守心跳 {age}s 前（疑似停摆）', dutyNone: '无常驻值守进程',
}
export const dashboardCopy = { en, zh }
export type DashboardFire = FireMessage & { sessionId: string; id: string; at: string }
export interface DashboardState {
  readonly watches: readonly WatchRow[]
  readonly recentFires: readonly DashboardFire[]
  readonly droppedWakeups?: Readonly<Record<string, number>>
  readonly duty?: { ageMs: number; stale: boolean } | null
}

/** Normal typed imports share the same templates and formatting between SSR and the browser. */
export function createDashboardRenderer(locale: Locale) {
  const copy = dashboardCopy[locale]
  const presentation = createPresentation(locale, messages[locale])
  const fill = (template: string, values: Record<string, number>): string => template.replace(/\{(\w+)\}/g,
    (token, key: string) => values[key] === undefined ? token : String(values[key]))
  const time = (value?: string): string => (value === undefined ? new Date() : new Date(value))
    .toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en')
  const badge = (kind: 'pending' | 'dropped', count: number): RenderedHtml => count > 0
    ? renderTemplate(badgeTemplate, { kind, label: fill(copy[kind], { n: count }) }) : joinHtml([])
  const rows = (watches: readonly WatchRow[], dropped: Readonly<Record<string, number>> = {}): RenderedHtml => {
    if (watches.length === 0) return renderTemplate(emptyTemplate, { columns: 9, message: copy.empty })
    return joinHtml(watches.map(row => renderTemplate(watchTemplate, {
      session: row.sessionId.slice(0, 16), sessionId: row.sessionId,
      live: row.live ? copy.live : copy.dormant,
      id: row.id, kind: row.kind, note: row.note, target: row.target,
      fireCount: row.fireCount, maxFires: row.maxFires,
      state: row.lastState === undefined ? copy.probing : presentation.localizeState(row.lastState),
      next: row.kind === 'webhook' ? copy.push
        : row.nextDueAt !== undefined ? `${String(Math.max(0, Math.ceil((row.nextDueAt - Date.now()) / 1000)))}s` : '…',
      cancel: copy.cancel,
    }, {
      dropped: badge('dropped', dropped[row.sessionId] ?? 0),
      pending: badge('pending', row.pendingWakeups),
      pattern: row.pattern === undefined ? renderTemplate('—', {}) : renderTemplate(patternTemplate, { pattern: row.pattern }),
    })))
  }
  const fires = (facts: readonly DashboardFire[]): RenderedHtml => facts.length === 0
    ? renderTemplate(emptyTemplate, { columns: 4, message: copy.firesEmpty })
    : joinHtml(facts.map(fire => renderTemplate(fireTemplate, {
      time: time(fire.at), id: fire.id, session: fire.sessionId.slice(0, 16), summary: presentation.formatFireSummary(fire),
    })))
  const meta = (count: number, duty?: DashboardState['duty']): string => {
    const dutyText = duty == null ? copy.dutyNone
      : fill(duty.stale ? copy.dutyStale : copy.duty, { age: Math.max(0, Math.round(duty.ageMs / 1000)) })
    return `· ${fill(copy.count, { n: count })} · ${dutyText} · ${time()}`
  }
  const headings = (labels: readonly string[]): RenderedHtml => joinHtml(labels.map(label => renderTemplate(headingTemplate, { label })))
  return { rows, fires, meta, headings }
}
