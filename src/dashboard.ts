import { readFile } from 'node:fs/promises'
import type { WatchRow } from './index.ts'
import { localizeState as stateLabel, type Locale } from './locale.ts'
import { createDashboardRenderer, dashboardCopy, type DashboardFire } from './dashboard-view.ts'
import { renderTemplate } from './dashboard-template.ts'
import pageTemplate from '../templates/dashboard.html?raw'

export const DASHBOARD_SCRIPT_PATH = '/plugins/dsh-sentinel/dashboard.js'

/** Source tests and installed lib/index.js both resolve the package's committed lib asset. */
export function dashboardScript(): Promise<string> {
  return readFile(new URL('../lib/dashboard.js', import.meta.url), 'utf8')
}

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
  return renderTemplate(pageTemplate, {
    lang: locale === 'zh' ? 'zh-CN' : 'en', title: copy.title, firesTitle: copy.firesTitle,
    scriptPath: DASHBOARD_SCRIPT_PATH,
  }, {
    'watch-headings': render.headings(copy.heads), 'fire-headings': render.headings(copy.fireHeads),
    watches: render.rows(rows, dropped), fires: render.fires(fires),
  })
}
