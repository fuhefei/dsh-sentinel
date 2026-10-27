import type { WatchRow } from './index.ts'
import { createPresentation, messages, type FireMessage, type Locale } from './locale.ts'
import Mustache from 'mustache'
import watchRowsTemplate from '../templates/dashboard/watches.html?raw'
import fireRowsTemplate from '../templates/dashboard/fires.html?raw'

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

/** Static, checked-in partials only; caller data is never interpreted as a template. */
export const dashboardPartials = {
  watchRows: watchRowsTemplate, fireRows: fireRowsTemplate,
}

/** Share plain presentation models and Mustache templates between SSR and the browser. */
export function createDashboardRenderer(locale: Locale) {
  const copy = dashboardCopy[locale]
  const presentation = createPresentation(locale, messages[locale])
  const fill = (template: string, values: Record<string, number>): string => template.replace(/\{(\w+)\}/g,
    (token, key: string) => values[key] === undefined ? token : String(values[key]))
  const time = (value?: string): string => (value === undefined ? new Date() : new Date(value))
    .toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en')
  const badge = (kind: 'pending' | 'dropped', count: number) => count > 0
    ? { label: fill(copy[kind], { n: count }) } : null
  const watchModel = (watches: readonly WatchRow[], dropped: Readonly<Record<string, number>> = {}) => ({
    watches: watches.map(row => ({
      session: row.sessionId.slice(0, 16), sessionId: row.sessionId,
      live: row.live ? copy.live : copy.dormant,
      id: row.id, kind: row.kind, note: row.note, target: row.target,
      fireCount: row.fireCount, maxFires: row.maxFires,
      state: row.lastState === undefined ? copy.probing : presentation.localizeState(row.lastState),
      next: row.kind === 'webhook' ? copy.push
        : row.nextDueAt !== undefined ? `${String(Math.max(0, Math.ceil((row.nextDueAt - Date.now()) / 1000)))}s` : '…',
      cancel: copy.cancel,
      dropped: badge('dropped', dropped[row.sessionId] ?? 0),
      pending: badge('pending', row.pendingWakeups),
      // An empty regex is present and must not be confused with an omitted pattern.
      patternView: row.pattern === undefined ? null : { pattern: row.pattern },
    })),
    emptyWatches: copy.empty,
  })
  const fireModel = (facts: readonly DashboardFire[]) => ({
    fires: facts.map(fire => ({
      time: time(fire.at), id: fire.id, session: fire.sessionId.slice(0, 16), summary: presentation.formatFireSummary(fire),
    })),
    emptyFires: copy.firesEmpty,
  })
  const rows = (watches: readonly WatchRow[], dropped: Readonly<Record<string, number>> = {}): string =>
    Mustache.render(watchRowsTemplate, watchModel(watches, dropped), dashboardPartials)
  const fires = (facts: readonly DashboardFire[]): string =>
    Mustache.render(fireRowsTemplate, fireModel(facts), dashboardPartials)
  const meta = (count: number, duty?: DashboardState['duty']): string => {
    const dutyText = duty == null ? copy.dutyNone
      : fill(duty.stale ? copy.dutyStale : copy.duty, { age: Math.max(0, Math.round(duty.ageMs / 1000)) })
    return `· ${fill(copy.count, { n: count })} · ${dutyText} · ${time()}`
  }
  return { rows, fires, meta, watchModel, fireModel }
}
