/**
 * dsh-sentinel, browser half: the transparency surface. A dock card above the
 * composer (official conversation.input.dock family, same visual language as
 * Goal / To-dos / task-status / loop) showing every active watch of the
 * current session: sensor, target, live probe state, fire budget, next probe
 * countdown — plus the recent fire history when expanded. A sidebar branch
 * under each watched session row (sidebar.workspaces.sessionRow.branch) makes
 * the server-global watch set visible from the workspace tree, with a link to
 * the node half's dashboard table. Polls the node half's read-only state
 * route; renders nothing when the session has no watches.
 */
import { useEffect, useState } from 'react'
import type { Context } from 'cordis'
import type { ReactNode } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls ui-workspace's SlotMap merges for the session-row holes.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sentinel watch-panel copy. */
    'sentinel': SentinelKey
  }
}

// Optional soft dependency on dsh-better-sidebar (omdsh-dev): its client half
// publishes ctx.betterSidebar, a documented third-party extension surface
// (registerTab / registerFileViewer). We restate the minimal contract here
// instead of value-importing the package, so sentinel builds and loads whether
// or not better-sidebar is installed; the tab registration below no-ops when
// the service is absent.
interface SentinelTabProps {
  readonly visible: boolean
}

interface SentinelTabDescriptor {
  readonly id: string
  readonly title: string | (() => string)
  readonly icon?: ReactNode | ((size: number) => ReactNode)
  readonly order?: number
  readonly single?: boolean
  readonly component: (props: SentinelTabProps) => ReactNode
}

interface BetterSidebarLike {
  registerTab(descriptor: SentinelTabDescriptor): () => void
}

declare module 'cordis' {
  interface Context {
    /** Present only when dsh-better-sidebar's client half is loaded. */
    readonly betterSidebar?: BetterSidebarLike
  }
}

const STATE_PATH = '/plugins/dsh-sentinel/state'
const DASHBOARD_PATH = '/plugins/dsh-sentinel/dashboard'
const POLL_MS = 2000

const NS = 'sentinel'
const zh = {
  'watching': '哨兵值守中',
  'count': '{count} 个监控',
  'fires': '触发 {n}/{max}',
  'next': '下次探测 {s}s',
  'probing': '探测中',
  'push': '即时推送',
  'open': '展开',
  'close': '收起',
  'history': '最近触发',
  'nofires': '尚未触发过',
  'branch': '👁 哨兵 · {count} 个监控',
  'dashboard': '全局总览 ↗',
  'dormant': '休眠',
  'live': '活跃',
  'tab': '哨兵监控',
  'tabempty': '当前没有活跃的监控。',
} satisfies Record<string, string>
type SentinelKey = keyof typeof zh
const en = {
  'watching': 'Sentinel on duty',
  'count': '{count} watch(es)',
  'fires': 'fired {n}/{max}',
  'next': 'next probe {s}s',
  'probing': 'probing',
  'push': 'live push',
  'open': 'Expand',
  'close': 'Collapse',
  'history': 'Recent fires',
  'nofires': 'No fires yet',
  'branch': '👁 sentinel · {count} watch(es)',
  'dashboard': 'All watches ↗',
  'dormant': 'dormant',
  'live': 'live',
  'tab': 'Sentinel',
  'tabempty': 'No active watches right now.',
} satisfies Record<string, string>

const SIDE_CLEARANCE = 'var(--dsh-composer-side-clearance, 16px)'
const DOCK_INSET = 'var(--dsh-composer-dock-inset, 8px)'
const CARD_MAX = 'var(--dsh-composer-card-max-width, 780px)'

interface WireWatch {
  sessionId: string
  live: boolean
  id: string
  kind: string
  target: string
  pattern?: string
  intervalSeconds: number
  note: string
  fireCount: number
  maxFires: number
  lastState?: string
  lastProbeAt?: number
  nextDueAt?: number
}

interface WireFire {
  sessionId: string
  id: string
  at: string
  summary: string
}

interface WireState {
  watches: WireWatch[]
  recentFires: WireFire[]
}

function useSentinelState(sessionId: string): WireState {
  const [state, setState] = useState<WireState>({ watches: [], recentFires: [] })
  useEffect(() => {
    let alive = true
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(`${STATE_PATH}?sessionId=${encodeURIComponent(sessionId)}`, { headers: { accept: 'application/json' } })
        if (!res.ok) return
        const data = (await res.json()) as Partial<WireState>
        if (alive && Array.isArray(data.watches)) {
          setState({ watches: data.watches, recentFires: Array.isArray(data.recentFires) ? data.recentFires : [] })
        }
      } catch {
        // transient network error: keep the previous frame, retry next tick
      }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [sessionId])
  return state
}

// Server-global watch set, shared by every sidebar branch instance: one
// unfiltered state-route poll with reference-counted start/stop, so N watched
// session rows cost one request per tick, not N.
let globalWatches: readonly WireWatch[] = []
let globalFires: readonly WireFire[] = []
const globalListeners = new Set<() => void>()
let globalTimer: ReturnType<typeof setInterval> | undefined

async function pollGlobal(): Promise<void> {
  try {
    const res = await fetch(STATE_PATH, { headers: { accept: 'application/json' } })
    if (!res.ok) return
    const data = (await res.json()) as Partial<WireState>
    if (Array.isArray(data.watches)) {
      globalWatches = data.watches
      globalFires = Array.isArray(data.recentFires) ? data.recentFires : []
      for (const listener of globalListeners) listener()
    }
  } catch {
    // transient network error: keep the previous frame, retry next tick
  }
}

function subscribeGlobal(listener: () => void): () => void {
  globalListeners.add(listener)
  if (globalTimer === undefined) {
    void pollGlobal()
    globalTimer = setInterval(() => { void pollGlobal() }, POLL_MS)
  }
  return () => {
    globalListeners.delete(listener)
    if (globalListeners.size === 0 && globalTimer !== undefined) {
      clearInterval(globalTimer)
      globalTimer = undefined
    }
  }
}

/** Subscribe to the server-global watch set (one shared poller per page). */
function useGlobalWatches(): readonly WireWatch[] {
  const [, force] = useState(0)
  useEffect(() => subscribeGlobal(() => { force(n => n + 1) }), [])
  return globalWatches
}

/** Subscribe to the server-global recent-fire list (same shared poller). */
function useGlobalFires(): readonly WireFire[] {
  const [, force] = useState(0)
  useEffect(() => subscribeGlobal(() => { force(n => n + 1) }), [])
  return globalFires
}

const KIND_GLYPHS: Record<string, string> = {
  file: '▤',
  command: '❯',
  http: '⇄',
  process: '▶',
  webhook: '⚡',
}

function countdown(nextDueAt: number | undefined): string {
  if (nextDueAt === undefined) return '…'
  return `${String(Math.max(0, Math.ceil((nextDueAt - Date.now()) / 1000)))}`
}

/** One watch row: glyph, id, target, live state, budget, cadence. */
function WatchRow(props: { watch: WireWatch; t: (key: SentinelKey, values?: Record<string, unknown>) => string }): ReactNode {
  const { watch, t } = props
  const cadence = watch.kind === 'webhook'
    ? t('push')
    : `${t('next', { s: countdown(watch.nextDueAt) })}${watch.kind === 'file' ? ` · ${t('push')}` : ''}`
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 12px', minHeight: 24 }}>
      <span style={{ flex: 'none', width: 14, textAlign: 'center', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
        {KIND_GLYPHS[watch.kind] ?? '•'}
      </span>
      <span style={{ flex: 'none', fontSize: 12, color: 'var(--dsw-alias-label-caption)', whiteSpace: 'nowrap' }}>{watch.id}</span>
      <span
        title={watch.pattern !== undefined ? `${watch.target}  /${watch.pattern}/\n${watch.note}` : `${watch.target}\n${watch.note}`}
        style={{
          flex: 1, minWidth: 0, overflow: 'hidden', fontSize: 13, lineHeight: '20px',
          color: 'var(--dsw-alias-label-primary-dimmed)', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {watch.target}
      </span>
      <span style={{ flex: 'none', fontSize: 12, color: 'var(--dsw-alias-label-caption)', whiteSpace: 'nowrap' }}>
        {watch.lastState ?? t('probing')} · {t('fires', { n: watch.fireCount, max: watch.maxFires })} · {cadence}
      </span>
    </div>
  )
}

/** The dock card: header always, rows + fire history when expanded. */
export function SentinelDock(
  props: PropsRuntime<'conversation.input.dock'> & PropsLocale<'sentinel'>,
): ReactNode {
  const { t, session } = props
  const { watches, recentFires } = useSentinelState(session.sessionId)
  const [inChat, setInChat] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const check = (): void => {
      setInChat(document.querySelector('[data-chat-flow=""]') !== null)
    }
    check()
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => { observer.disconnect() }
  }, [])

  if (!inChat || watches.length === 0) return null

  return (
    <div
      data-sentinel-dock=""
      style={{
        boxSizing: 'border-box',
        width: `calc(100% - 2 * ${SIDE_CLEARANCE} - 4 * ${DOCK_INSET})`,
        maxWidth: `calc(${CARD_MAX} - 4 * ${DOCK_INSET})`,
        margin: '0 auto',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 12,
        background: 'var(--dsw-specific-tip)',
        overflow: 'hidden',
        fontSize: 13,
        fontFamily: 'system-ui',
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', cursor: 'pointer' }}
        onClick={() => { setOpen(value => !value) }}
      >
        <span style={{ display: 'inline-flex', flex: 'none', alignItems: 'center', gap: 8 }}>
          <StateDot state="ongoing" size={10} />
          <span aria-hidden style={{ fontSize: 13, lineHeight: '16px' }}>👁</span>
        </span>
        <span style={{ flex: 'none', fontSize: 13, lineHeight: '24px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }}>
          {t('watching')}
        </span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', fontSize: 12, color: 'var(--dsw-alias-label-caption)', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {t('count', { count: watches.length })}
          {' · '}
          {watches.map(watch => watch.id).join(' ')}
        </span>
        <span style={{ flex: 'none', fontSize: 12, color: 'var(--dsw-alias-label-caption)' }}>
          {open ? t('close') : t('open')}
        </span>
      </div>
      {open && (
        <div style={{ maxHeight: 220, overflowY: 'auto', borderTop: '1px solid var(--dsw-alias-border-l1)', padding: '4px 0' }}>
          {watches.map(watch => <WatchRow key={watch.id} watch={watch} t={t} />)}
          <div style={{ padding: '4px 12px 2px', fontSize: 11, fontWeight: 500, color: 'var(--dsw-alias-label-caption)' }}>
            {t('history')}
          </div>
          {recentFires.length === 0
            ? <div style={{ padding: '0 12px 4px', fontSize: 12, color: 'var(--dsw-alias-label-caption)' }}>{t('nofires')}</div>
            : recentFires.slice(0, 8).map(fire => (
              <div key={`${fire.id}-${fire.at}`} style={{ display: 'flex', gap: 10, padding: '1px 12px', fontSize: 12, color: 'var(--dsw-alias-label-caption)' }}>
                <span style={{ flex: 'none', whiteSpace: 'nowrap' }}>{new Date(fire.at).toLocaleTimeString()}</span>
                <span style={{ flex: 'none' }}>{fire.id}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fire.summary}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

/**
 * Row-below sidebar branch: one instance per session row, fed by the shared
 * global poller. Collapsed it is a single 👁 row with the watch count;
 * expanded it lists this session's watches and links to the dashboard table.
 * Renders nothing when the session has no watches, so unwatched rows are
 * untouched.
 */
export function SentinelBranch(
  props: PropsRuntime<'sidebar.workspaces.sessionRow.branch'> & PropsLocale<'sentinel'>,
): ReactNode {
  const { sessionId, t } = props
  const watches = useGlobalWatches()
  const [open, setOpen] = useState(false)
  const mine = watches.filter(watch => watch.sessionId === sessionId)
  if (mine.length === 0) return null

  return (
    <div
      data-sentinel-branch=""
      style={{
        margin: '0 0 2px 26px',
        borderLeft: '2px solid var(--dsw-alias-border-l1)',
        paddingLeft: 10,
        fontSize: 12,
        fontFamily: 'system-ui',
        color: 'var(--dsw-alias-label-caption)',
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', cursor: 'pointer' }}
        onClick={(e) => { e.stopPropagation(); setOpen(value => !value) }}
      >
        <span aria-hidden style={{ fontSize: 10 }}>{open ? '▾' : '▸'}</span>
        <StateDot state="ongoing" size={8} />
        <span>{t('branch', { count: mine.length })}</span>
        <a
          href={DASHBOARD_PATH}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => { e.stopPropagation() }}
          style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--dsw-alias-label-caption)', textDecoration: 'none' }}
        >
          {t('dashboard')}
        </a>
      </div>
      {open && mine.map(watch => (
        <div
          key={watch.id}
          title={watch.pattern !== undefined ? `${watch.target}  /${watch.pattern}/\n${watch.note}` : `${watch.target}\n${watch.note}`}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '1px 0 1px 16px', minWidth: 0 }}
        >
          <span style={{ flex: 'none', width: 12, textAlign: 'center', color: 'var(--dsw-alias-label-tertiary)' }}>
            {KIND_GLYPHS[watch.kind] ?? '•'}
          </span>
          <span style={{ flex: 'none' }}>{watch.id}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {watch.target}
          </span>
          <span style={{ flex: 'none', whiteSpace: 'nowrap' }}>
            {watch.lastState ?? t('probing')} · {t('fires', { n: watch.fireCount, max: watch.maxFires })}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * better-sidebar tab view: the server-global watch table inside the sidebar
 * workbench. better-sidebar's tab contract passes no locale props, so copy
 * falls back to the browser language (their documented guidance for consumer
 * tabs is plain strings / () => string).
 */
export function SentinelTabView(): ReactNode {
  const watches = useGlobalWatches()
  const fires = useGlobalFires()
  const t = (key: SentinelKey, values?: Record<string, unknown>): string => {
    const template = (navigator.language.startsWith('zh') ? zh : en)[key]
    if (values === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      values[name] !== undefined ? String(values[name]) : match)
  }

  return (
    <div
      data-sentinel-tab=""
      style={{
        height: '100%', overflowY: 'auto', padding: '8px 0',
        fontSize: 13, fontFamily: 'system-ui', color: 'var(--dsw-alias-label-primary-dimmed)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 12px 6px' }}>
        <StateDot state="ongoing" size={10} />
        <span style={{ fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }}>{t('tab')}</span>
        <span style={{ flex: 1, fontSize: 12, color: 'var(--dsw-alias-label-caption)' }}>
          {t('count', { count: watches.length })}
        </span>
        <a
          href={DASHBOARD_PATH}
          target="_blank"
          rel="noreferrer"
          style={{ flex: 'none', fontSize: 11, color: 'var(--dsw-alias-label-caption)', textDecoration: 'none' }}
        >
          {t('dashboard')}
        </a>
      </div>
      {watches.length === 0 && (
        <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--dsw-alias-label-caption)' }}>
          {t('tabempty')}
        </div>
      )}
      {watches.map(watch => (
        <div key={`${watch.sessionId}-${watch.id}`}>
          <div style={{ padding: '4px 12px 0', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
            {watch.sessionId} · {watch.live ? t('live') : t('dormant')}
          </div>
          <WatchRow watch={watch} t={t} />
        </div>
      ))}
      {watches.length > 0 && (
        <div style={{ padding: '8px 12px 2px', fontSize: 11, fontWeight: 500, color: 'var(--dsw-alias-label-caption)' }}>
          {t('history')}
        </div>
      )}
      {fires.length === 0
        ? watches.length > 0 && (
          <div style={{ padding: '0 12px 4px', fontSize: 12, color: 'var(--dsw-alias-label-caption)' }}>
            {t('nofires')}
          </div>
        )
        : fires.slice(0, 12).map(fire => (
          <div
            key={`${fire.sessionId}-${fire.id}-${fire.at}`}
            style={{ display: 'flex', gap: 8, padding: '1px 12px', fontSize: 12, color: 'var(--dsw-alias-label-caption)' }}
          >
            <span style={{ flex: 'none', whiteSpace: 'nowrap' }}>{new Date(fire.at).toLocaleTimeString()}</span>
            <span style={{ flex: 'none' }}>{fire.id}</span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {fire.summary}
            </span>
          </div>
        ))}
    </div>
  )
}

/** Required client services: slot registry and locale dictionaries. betterSidebar
 * is declared but optional — absent when better-sidebar is not installed. */
export const inject = ['slots', 'locale', 'betterSidebar']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'sentinel: dictionaries')
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'sentinel',
      order: 24,
      locale: NS,
    }, SentinelDock))
  // The branch hole is declared by ui-workspace's browser registration, whose
  // activation order is not constrained against this plugin; inject runs the
  // register once the declaration lands (immediately when it already exists).
  ctx.slots.inject('sidebar.workspaces.sessionRow.branch', () =>
    ctx.slots.register({
      name: 'sidebar.workspaces.sessionRow.branch',
      id: 'sentinel',
      locale: NS,
    }, SentinelBranch))
  // Soft integration with dsh-better-sidebar: register the global watch table
  // as a sidebar tab when its service is published; silently skip otherwise.
  if (ctx.betterSidebar !== undefined) {
    const sidebar = ctx.betterSidebar
    ctx.effect(() => sidebar.registerTab({
      id: 'dsh-sentinel:watches',
      title: () => (navigator.language.startsWith('zh') ? zh : en)['tab'],
      icon: (size: number) => (
        <span aria-hidden style={{ fontSize: Math.max(12, size - 2), lineHeight: 1 }}>👁</span>
      ),
      order: 60,
      single: true,
      component: () => <SentinelTabView />,
    }), 'sentinel: better-sidebar tab')
  }
}
