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
  'history': '最近触发',
  'nofires': '尚未触发过',
  'branch': '哨兵 · {count} 个监控',
  'noteLabel': '便签',
  'before': '之前',
  'after': '现在',
  'emptyHint': '让 agent 用 sentinel_watch 注册第一个监控。',
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
  'history': 'Recent fires',
  'nofires': 'No fires yet',
  'branch': 'sentinel · {count} watch(es)',
  'noteLabel': 'note',
  'before': 'before',
  'after': 'after',
  'emptyHint': 'Ask the agent to register a watch with sentinel_watch.',
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
  note: string
  before: string
  after: string
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

/** Single-color inline icons (currentColor): one visual language across the
 * dock, branch, tab and every platform — no emoji rendering drift. */
const ICON_PATHS = {
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
  file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z', 'M14 2v6h6'],
  command: ['M4 17l6-6-6-6', 'M12 19h8'],
  http: ['M8 3 4 7l4 4', 'M4 7h16', 'M16 21l4-4-4-4', 'M20 17H4'],
  process: ['M6 4l14 8-14 8Z'],
  port: ['M9 2v6', 'M15 2v6', 'M6 8h12v4a6 6 0 0 1-12 0Z', 'M12 18v4'],
  webhook: ['M13 2 3 14h7l-1 8 10-12h-7Z'],
  chevron: ['M6 9l6 6 6-6'],
} as const

function Icon(props: { name: keyof typeof ICON_PATHS; size?: number }): ReactNode {
  const { name, size = 14 } = props
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: 'none', display: 'block' }}
    >
      {ICON_PATHS[name].map(path => <path key={path} d={path} />)}
    </svg>
  )
}

const KIND_ICONS: Record<string, keyof typeof ICON_PATHS> = {
  file: 'file',
  command: 'command',
  http: 'http',
  process: 'process',
  port: 'port',
  webhook: 'webhook',
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
      <span style={{ flex: 'none', display: 'inline-flex', width: 16, justifyContent: 'center', color: 'var(--dsw-alias-label-tertiary)' }}>
        <Icon name={KIND_ICONS[watch.kind] ?? 'file'} size={13} />
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
      <span style={{ flex: 'none', fontSize: 12, color: 'var(--dsw-alias-label-caption)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        {watch.lastState ?? t('probing')} · {t('fires', { n: watch.fireCount, max: watch.maxFires })} · {cadence}
      </span>
    </div>
  )
}

/**
 * One fire in the history list: a single receipt line, expandable into the
 * full wakeup context — the note the user left for themselves plus the
 * before → after snapshot transition (the transparency this plugin promises).
 */
function FireRow(props: { fire: WireFire; t: (key: SentinelKey, values?: Record<string, unknown>) => string }): ReactNode {
  const { fire, t } = props
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  return (
    <div style={{ borderRadius: 6 }}>
      <div
        onClick={() => { setOpen(value => !value) }}
        onMouseEnter={() => { setHover(true) }}
        onMouseLeave={() => { setHover(false) }}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '2px 12px', fontSize: 12,
          color: 'var(--dsw-alias-label-caption)', cursor: 'pointer', borderRadius: 6,
          background: hover ? 'var(--dsw-alias-fill-secondary, rgba(127,127,127,.08))' : 'transparent',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <span
          style={{ flex: 'none', display: 'inline-flex', color: 'var(--dsw-alias-label-tertiary)', transition: 'transform .15s ease', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          <Icon name="chevron" size={11} />
        </span>
        <span style={{ flex: 'none', whiteSpace: 'nowrap' }}>{new Date(fire.at).toLocaleTimeString()}</span>
        <span style={{ flex: 'none' }}>{fire.id}</span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fire.summary}</span>
      </div>
      {open && (
        <div style={{ padding: '2px 12px 6px 30px', fontSize: 12, color: 'var(--dsw-alias-label-caption)' }}>
          <div style={{ marginBottom: 4 }}>
            <span style={{ fontWeight: 500 }}>{t('noteLabel')}</span>
            {'：'}
            {fire.note}
          </div>
          <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
            <pre style={{ flex: 1, margin: 0, padding: '4px 6px', borderRadius: 6, overflow: 'auto', maxHeight: 120, fontSize: 11, lineHeight: '16px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--dsw-alias-fill-secondary, rgba(127,127,127,.08))' }}>
              {t('before')}
              {'\n'}
              {fire.before === '' ? '—' : fire.before}
            </pre>
            <span style={{ flex: 'none', alignSelf: 'center', color: 'var(--dsw-alias-label-tertiary)' }}>
              <Icon name="chevron" size={12} />
            </span>
            <pre style={{ flex: 1, margin: 0, padding: '4px 6px', borderRadius: 6, overflow: 'auto', maxHeight: 120, fontSize: 11, lineHeight: '16px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--dsw-alias-fill-secondary, rgba(127,127,127,.08))' }}>
              {t('after')}
              {'\n'}
              {fire.after}
            </pre>
          </div>
        </div>
      )}
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
        <span style={{ display: 'inline-flex', flex: 'none', alignItems: 'center', gap: 8, color: 'var(--dsw-alias-label-primary)' }}>
          <StateDot state="ongoing" size={10} />
          <Icon name="eye" size={14} />
        </span>
        <span style={{ flex: 'none', fontSize: 13, lineHeight: '24px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }}>
          {t('watching')}
        </span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', fontSize: 12, color: 'var(--dsw-alias-label-caption)', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {t('count', { count: watches.length })}
          {' · '}
          {watches.map(watch => watch.id).join(' ')}
        </span>
        <a
          href={DASHBOARD_PATH}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => { e.stopPropagation() }}
          style={{ flex: 'none', fontSize: 11, color: 'var(--dsw-alias-label-caption)', textDecoration: 'none' }}
        >
          {t('dashboard')}
        </a>
        <span
          style={{ flex: 'none', display: 'inline-flex', color: 'var(--dsw-alias-label-caption)', transition: 'transform .2s ease', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          <Icon name="chevron" size={13} />
        </span>
      </div>
      <div
        style={{
          maxHeight: open ? 260 : 0, opacity: open ? 1 : 0,
          overflowY: open ? 'auto' : 'hidden', overflowX: 'hidden',
          borderTop: open ? '1px solid var(--dsw-alias-border-l1)' : '1px solid transparent',
          transition: 'max-height .2s ease, opacity .15s ease',
        }}
      >
        <div style={{ padding: '4px 0' }}>
          {watches.map(watch => <WatchRow key={watch.id} watch={watch} t={t} />)}
          <div style={{ padding: '4px 12px 2px', fontSize: 11, fontWeight: 500, color: 'var(--dsw-alias-label-caption)' }}>
            {t('history')}
          </div>
          {recentFires.length === 0
            ? <div style={{ padding: '0 12px 4px', fontSize: 12, color: 'var(--dsw-alias-label-caption)' }}>{t('nofires')}</div>
            : recentFires.slice(0, 8).map(fire => <FireRow key={`${fire.id}-${fire.at}`} fire={fire} t={t} />)}
        </div>
      </div>
    </div>
  )
}

/**
 * Row-below sidebar branch: one instance per session row, fed by the shared
 * global poller. Collapsed it is a single eye-iconed row with the watch count;
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
        <span style={{ flex: 'none', display: 'inline-flex', color: 'var(--dsw-alias-label-tertiary)', transition: 'transform .15s ease', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>
          <Icon name="chevron" size={10} />
        </span>
        <StateDot state="ongoing" size={8} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icon name="eye" size={11} />
          {t('branch', { count: mine.length })}
        </span>
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
          <span style={{ flex: 'none', width: 16, display: 'inline-flex', justifyContent: 'center', color: 'var(--dsw-alias-label-tertiary)' }}>
            <Icon name={KIND_ICONS[watch.kind] ?? 'file'} size={11} />
          </span>
          <span style={{ flex: 'none' }}>{watch.id}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {watch.target}
          </span>
          <span style={{ flex: 'none', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
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
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }}>
          <Icon name="eye" size={13} />
          {t('tab')}
        </span>
        <span style={{ flex: 1, fontSize: 12, color: 'var(--dsw-alias-label-caption)', fontVariantNumeric: 'tabular-nums' }}>
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
          <div style={{ marginTop: 4, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{t('emptyHint')}</div>
        </div>
      )}
      {[...watches.reduce((groups, watch) => {
        const list = groups.get(watch.sessionId) ?? []
        list.push(watch)
        groups.set(watch.sessionId, list)
        return groups
      }, new Map<string, WireWatch[]>()).entries()].map(([sessionId, group]) => (
        <div key={sessionId}>
          <div style={{ padding: '6px 12px 0', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
            {sessionId} · {group[0]?.live === true ? t('live') : t('dormant')}
          </div>
          {group.map(watch => <WatchRow key={watch.id} watch={watch} t={t} />)}
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
        : fires.slice(0, 12).map(fire => <FireRow key={`${fire.sessionId}-${fire.id}-${fire.at}`} fire={fire} t={t} />)}
    </div>
  )
}

/** Required client services: slot registry and locale dictionaries. betterSidebar
 * stays out of the static inject — on hosts without better-sidebar a missing
 * service would leave this plugin pending and take the whole web boot down.
 * The tab mounts via an eager check plus the service-landing event instead. */
export const inject = ['slots', 'locale']

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
  // Soft integration with dsh-better-sidebar. betterSidebar stays out of the
  // static inject — a missing service would leave this plugin pending and take
  // the whole web boot down on hosts without better-sidebar. The tab mounts
  // eagerly when the service is already up (bundle order), and otherwise on
  // the cordis service-landing event (fiber-scoped listener, self-cleaning).
  let tabMounted = false
  const mountSidebarTab = (sidebar: BetterSidebarLike): void => {
    if (tabMounted) return
    tabMounted = true
    ctx.effect(() => sidebar.registerTab({
      id: 'dsh-sentinel:watches',
      title: () => (navigator.language.startsWith('zh') ? zh : en)['tab'],
      icon: (size: number) => <Icon name="eye" size={Math.max(12, size - 2)} />,
      order: 60,
      single: true,
      component: () => <SentinelTabView />,
    }), 'sentinel: better-sidebar tab')
  }
  const sidebarNow = (ctx as unknown as { betterSidebar?: BetterSidebarLike }).betterSidebar
  if (sidebarNow !== undefined) {
    mountSidebarTab(sidebarNow)
  } else {
    ;(ctx as unknown as { on: (event: string, callback: (...args: never[]) => void) => () => void }).on('internal/service', ((name: string) => {
      if (name !== 'betterSidebar') return
      const sidebar = (ctx as unknown as { betterSidebar?: BetterSidebarLike }).betterSidebar
      if (sidebar !== undefined) mountSidebarTab(sidebar)
    }) as never)
  }
}
