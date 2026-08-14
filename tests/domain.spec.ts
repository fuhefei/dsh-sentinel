import { describe, expect, it } from 'vitest'
import {
  allocateWatchId,
  clipExcerpt,
  decodeSentinelChange,
  foldSentinelEvents,
  MAX_EXCERPT_LENGTH,
  normalizeSpec,
  renderWakeup,
  SENTINEL_CHANGE_TYPE,
  SENTINEL_CHANGE_VERSION,
  SentinelLogError,
  type Subscription,
} from '../src/domain.ts'

function createdEvent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    type: SENTINEL_CHANGE_TYPE,
    payload: {
      version: SENTINEL_CHANGE_VERSION,
      change: 'created',
      subscription: {
        id,
        spec: { kind: 'file', target: '/tmp/x', intervalSeconds: 30 },
        note: 'continue the deploy',
        maxFires: 2,
        cooldownSeconds: 60,
        createdAt: '2026-08-12T00:00:00.000Z',
        ...overrides,
      },
    },
  }
}

function baselineEvent(id: string, state: string, snapshot: string) {
  return {
    type: SENTINEL_CHANGE_TYPE,
    payload: {
      version: SENTINEL_CHANGE_VERSION,
      change: 'baseline',
      id,
      at: '2026-08-12T00:00:01.000Z',
      observed: { state, snapshot },
    },
  }
}

function firedEvent(id: string, at: string, observed?: { state: string; snapshot: string }) {
  return {
    type: SENTINEL_CHANGE_TYPE,
    payload: {
      version: SENTINEL_CHANGE_VERSION,
      change: 'fired',
      id,
      at,
      fact: { fireNumber: 1, summary: 's', before: '', after: 'a', probeMs: 3 },
      ...(observed !== undefined ? { observed } : {}),
    },
  }
}

describe('normalizeSpec', () => {
  it('clamps the interval into bounds', () => {
    expect(normalizeSpec({ kind: 'file', target: '/a', intervalSeconds: 1 }).intervalSeconds).toBe(5)
    expect(normalizeSpec({ kind: 'file', target: '/a', intervalSeconds: 999_999 }).intervalSeconds).toBe(86_400)
  })

  it('defaults a missing interval to 30 seconds', () => {
    expect(normalizeSpec({ kind: 'http', target: 'http://x' }).intervalSeconds).toBe(30)
  })

  it('rejects unknown kinds, empty targets, and broken regexes', () => {
    expect(() => normalizeSpec({ kind: 'quantum', target: '/a' })).toThrow(SentinelLogError)
    expect(() => normalizeSpec({ kind: 'file', target: '  ' })).toThrow(SentinelLogError)
    expect(() => normalizeSpec({ kind: 'file', target: '/a', pattern: '(' })).toThrow(SentinelLogError)
  })

  it('validates port targets and trims them', () => {
    expect(normalizeSpec({ kind: 'port', target: ' db.internal:5432 ' }).target).toBe('db.internal:5432')
    expect(() => normalizeSpec({ kind: 'port', target: '70000' })).toThrow(SentinelLogError)
    expect(() => normalizeSpec({ kind: 'port', target: 'not a port' })).toThrow(SentinelLogError)
  })
})

describe('foldSentinelEvents', () => {
  it('rebuilds active subscriptions and fire counts', () => {
    const folded = foldSentinelEvents([
      createdEvent('watch-1'),
      firedEvent('watch-1', '2026-08-12T01:00:00.000Z'),
      { type: 'other/event', payload: {} },
    ])
    const sub = folded.active.get('watch-1')
    expect(sub?.fireCount).toBe(1)
    expect(sub?.lastFiredAt).toBe('2026-08-12T01:00:00.000Z')
  })

  it('drops a subscription when fires exhaust maxFires', () => {
    const folded = foldSentinelEvents([
      createdEvent('watch-1'),
      firedEvent('watch-1', '2026-08-12T01:00:00.000Z'),
      firedEvent('watch-1', '2026-08-12T02:00:00.000Z'),
    ])
    expect(folded.active.has('watch-1')).toBe(false)
  })

  it('drops cancelled subscriptions', () => {
    const folded = foldSentinelEvents([
      createdEvent('watch-1'),
      {
        type: SENTINEL_CHANGE_TYPE,
        payload: { version: SENTINEL_CHANGE_VERSION, change: 'cancelled', id: 'watch-1', at: 'x', reason: 'agent' },
      },
    ])
    expect(folded.active.size).toBe(0)
  })

  it('keeps fired-but-undelivered fires for the boot requeue', () => {
    const folded = foldSentinelEvents([
      createdEvent('watch-1'),
      firedEvent('watch-1', '2026-08-12T01:00:00.000Z'),
    ])
    expect(folded.undeliveredFires.length).toBe(1)
    expect(folded.undeliveredFires[0]?.fact.fireNumber).toBe(1)
  })

  it('clears undelivered fires behind a delivered watermark, keeps later ones', () => {
    const folded = foldSentinelEvents([
      createdEvent('watch-1'),
      firedEvent('watch-1', '2026-08-12T01:00:00.000Z'),
      { type: SENTINEL_CHANGE_TYPE, payload: { version: SENTINEL_CHANGE_VERSION, change: 'delivered', at: '2026-08-12T01:00:01.000Z' } },
      firedEvent('watch-1', '2026-08-12T02:00:00.000Z'),
    ])
    expect(folded.undeliveredFires.length).toBe(1)
    expect(folded.undeliveredFires[0]?.at).toBe('2026-08-12T02:00:00.000Z')
  })

  it('cancellation withdraws queued undelivered wakeups', () => {
    const folded = foldSentinelEvents([
      createdEvent('watch-1'),
      firedEvent('watch-1', '2026-08-12T01:00:00.000Z'),
      {
        type: SENTINEL_CHANGE_TYPE,
        payload: { version: SENTINEL_CHANGE_VERSION, change: 'cancelled', id: 'watch-1', at: '2026-08-12T01:00:01.000Z', reason: 'agent' },
      },
    ])
    expect(folded.undeliveredFires.length).toBe(0)
  })

  it('allocates monotonically past every seen ordinal', () => {
    const folded = foldSentinelEvents([createdEvent('watch-7')])
    expect(allocateWatchId(folded)).toBe('watch-8')
  })

  it('fails loudly on a corrupt row', () => {
    expect(() => foldSentinelEvents([
      { type: SENTINEL_CHANGE_TYPE, payload: { version: 99, change: 'created' } },
    ])).toThrow(SentinelLogError)
  })

  it('seeds lastKnown from a baseline event and updates it on observed fires', () => {
    const folded = foldSentinelEvents([
      createdEvent('watch-1'),
      baselineEvent('watch-1', 'absent', ''),
    ])
    expect(folded.active.get('watch-1')?.lastKnown).toEqual({ state: 'absent', snapshot: '' })

    const afterFire = foldSentinelEvents([
      createdEvent('watch-1'),
      baselineEvent('watch-1', 'absent', ''),
      firedEvent('watch-1', '2026-08-12T00:01:00.000Z', { state: 'exists', snapshot: 'READY\n' }),
    ])
    expect(afterFire.active.get('watch-1')?.lastKnown).toEqual({ state: 'exists', snapshot: 'READY\n' })
  })

  it('keeps the previous lastKnown across a legacy fired event without observed', () => {
    const folded = foldSentinelEvents([
      createdEvent('watch-1'),
      baselineEvent('watch-1', 'absent', ''),
      firedEvent('watch-1', '2026-08-12T00:01:00.000Z'),
    ])
    expect(folded.active.get('watch-1')?.lastKnown).toEqual({ state: 'absent', snapshot: '' })
  })

  it('rejects a malformed observed snapshot', () => {
    expect(() => foldSentinelEvents([
      createdEvent('watch-1'),
      { type: SENTINEL_CHANGE_TYPE, payload: { version: SENTINEL_CHANGE_VERSION, change: 'baseline', id: 'watch-1', at: 't', observed: { state: 7 } } },
    ])).toThrow(SentinelLogError)
  })
})

describe('decodeSentinelChange', () => {
  it('round-trips a created payload', () => {
    const decoded = decodeSentinelChange(createdEvent('watch-2').payload)
    expect(decoded.change).toBe('created')
  })

  it('rejects unknown change kinds', () => {
    expect(() => decodeSentinelChange({ version: SENTINEL_CHANGE_VERSION, change: 'mutated' })).toThrow(SentinelLogError)
  })
})

describe('compacted change', () => {
  function compactedEvent(overrides: Record<string, unknown> = {}) {
    return {
      type: SENTINEL_CHANGE_TYPE,
      payload: {
        version: SENTINEL_CHANGE_VERSION,
        change: 'compacted',
        subscription: {
          id: 'watch-7',
          spec: { kind: 'file', target: '/tmp/deploy.lock', pattern: 'RELEASE', intervalSeconds: 15 },
          note: 'release lock appeared',
          maxFires: 5,
          cooldownSeconds: 60,
          createdAt: '2026-08-13T00:00:00.000Z',
          fireCount: 2,
          lastFiredAt: '2026-08-13T06:00:00.000Z',
          lastKnown: { state: 'exists (12 bytes)', snapshot: 'size=12 mtime=1\nRELEASE' },
          ...overrides,
        },
      },
    }
  }

  it('folds back the subscription with fire budget and baseline intact', () => {
    const folded = foldSentinelEvents([compactedEvent()])
    const sub = folded.active.get('watch-7')
    expect(sub?.fireCount).toBe(2)
    expect(sub?.lastFiredAt).toBe('2026-08-13T06:00:00.000Z')
    expect(sub?.lastKnown?.state).toBe('exists (12 bytes)')
    expect(folded.lastOrdinal).toBe(7)
  })

  it('rejects a negative folded fireCount', () => {
    expect(() => foldSentinelEvents([compactedEvent({ fireCount: -1 })])).toThrow(SentinelLogError)
  })

  it('rejects a missing lastKnown shape', () => {
    expect(() => foldSentinelEvents([compactedEvent({ lastKnown: { state: 'x' } })])).toThrow(SentinelLogError)
  })
})

describe('renderWakeup', () => {
  const sub: Subscription = {
    id: 'watch-3',
    spec: { kind: 'command', target: 'systemctl is-active dsh-web', pattern: 'inactive', intervalSeconds: 30 },
    note: '服务挂了先看 journalctl 再重启',
    maxFires: 2,
    cooldownSeconds: 60,
    createdAt: '2026-08-12T00:00:00.000Z',
    fireCount: 0,
  }

  it('carries the receipt, the fact, and the note verbatim', () => {
    const body = renderWakeup(sub, { fireNumber: 1, summary: '模式开始匹配', before: 'active', after: 'inactive', probeMs: 12 })
    expect(body).toContain('watch-3')
    expect(body).toContain('第 1/2 次')
    expect(body).toContain('服务挂了先看 journalctl 再重启')
    expect(body).toContain("剩余 1 次")
    expect(body).toContain("sentinel_cancel")
  })

  it('marks the final fire as terminal', () => {
    const body = renderWakeup({ ...sub, fireCount: 1 }, { fireNumber: 2, summary: 's', before: '', after: 'x', probeMs: 1 })
    expect(body).toContain('最后一次触发')
  })
})

describe('clipExcerpt', () => {
  it('passes short text through and clips long text', () => {
    expect(clipExcerpt('abc')).toBe('abc')
    const clipped = clipExcerpt('x'.repeat(MAX_EXCERPT_LENGTH + 10))
    expect(clipped.length).toBeLessThan(MAX_EXCERPT_LENGTH + 40)
    expect(clipped).toContain('more chars')
  })
})
