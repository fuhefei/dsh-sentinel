/**
 * dsh-sentinel, browser half: the transparency surface. A dock card above the
 * composer (official conversation.input.dock family, same visual language as
 * Goal / To-dos / task-status / loop) showing every active watch of the
 * current session: sensor, target, live probe state, fire budget, next probe
 * countdown — plus the recent fire history when expanded. Polls the node
 * half's read-only state route; renders nothing when the session has no
 * watches.
 */
import { useEffect, useState } from 'react'
import type { Context } from 'cordis'
import type { ReactNode } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sentinel watch-panel copy. */
    'sentinel': SentinelKey
  }
}

const STATE_PATH = '/plugins/dsh-sentinel/state'
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
} satisfies Record<string, string>

const SIDE_CLEARANCE = 'var(--dsh-composer-side-clearance, 16px)'
const DOCK_INSET = 'var(--dsh-composer-dock-inset, 8px)'
const CARD_MAX = 'var(--dsh-composer-card-max-width, 780px)'

interface WireWatch {
  sessionId: string
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

/** Required client services: slot registry and locale dictionaries. */
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
}
