import type { WatchRow } from './index.ts'
import { localizeState as stateLabel, type Locale } from './locale.ts'
import Mustache from 'mustache'
import { createDashboardRenderer, dashboardCopy, dashboardPartials, type DashboardFire } from './dashboard-view.ts'
import documentTemplate from '../templates/layouts/document.html?raw'
import dashboardTemplate from '../templates/dashboard.html?raw'

export const DASHBOARD_SCRIPT_PATH = '/plugins/dsh-sentinel/dashboard.js'
export const DASHBOARD_STYLE_PATH = '/plugins/dsh-sentinel/dashboard.css'
export const DASHBOARD_ICON_PATH = '/plugins/dsh-sentinel/icon.svg'

/** Fixed package-relative assets work from source and installed lib without a workspace fallback. */
export const dashboardAssets = [
  { path: DASHBOARD_SCRIPT_PATH, contentType: 'text/javascript; charset=utf-8', file: new URL('../lib/dashboard.js', import.meta.url) },
  { path: DASHBOARD_STYLE_PATH, contentType: 'text/css; charset=utf-8', file: new URL('../lib/dashboard.css', import.meta.url) },
  { path: DASHBOARD_ICON_PATH, contentType: 'image/svg+xml; charset=utf-8', file: new URL('../icon.svg', import.meta.url) },
] as const

/** Retain the original public boolean helper while using shared presentation rules. */
export function localizeState(state: string, zh: boolean): string {
  return stateLabel(state, zh ? 'zh' : 'en')
}

/** Render the external HTML template; no executable JavaScript or event handlers are interpolated. */
export function dashboardHtml(
  rows: readonly WatchRow[],
  fires: readonly DashboardFire[] = [],
  dropped: Readonly<Record<string, number>> = {},
  locale: Locale = 'en',
): string {
  const copy = dashboardCopy[locale]
  const render = createDashboardRenderer(locale)
  return Mustache.render(documentTemplate, {
    lang: locale === 'zh' ? 'zh-CN' : 'en', title: copy.title, firesTitle: copy.firesTitle, watchesTitle: copy.watchesTitle,
    scriptPath: DASHBOARD_SCRIPT_PATH, stylePath: DASHBOARD_STYLE_PATH, iconPath: DASHBOARD_ICON_PATH,
    watchHeadings: copy.heads.map(label => ({ label })), fireHeadings: copy.fireHeads.map(label => ({ label })),
    ...render.watchModel(rows, dropped), ...render.fireModel(fires),
  }, { dashboard: dashboardTemplate, ...dashboardPartials })
}
