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

function firedEvent(id: string, at: string, observed?: { state: string; snapshot: string }, trigger?: unknown) {
  return {
    type: SENTINEL_CHANGE_TYPE,
    payload: {
      version: SENTINEL_CHANGE_VERSION,
      change: 'fired',
      id,
      at,
      fact: { fireNumber: 1, summary: 's', before: '', after: 'a', probeMs: 3, ...(trigger !== undefined ? { trigger } : {}) },
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

  it('accepts session watches: target is the observed session id and pattern is optional', () => {
    expect(normalizeSpec({ kind: 'session', target: ' session-b ', intervalSeconds: 1 })).toEqual({
      kind: 'session', target: 'session-b', intervalSeconds: 5,
    })
    expect(normalizeSpec({ kind: 'session', target: 'session-b', pattern: '^(completed|max-tokens)$' }).pattern)
      .toBe('^(completed|max-tokens)$')
    expect(() => normalizeSpec({ kind: 'session', target: '   ' })).toThrow(SentinelLogError)
    expect(() => normalizeSpec({ kind: 'session', target: 'session-b', pattern: '(' })).toThrow(SentinelLogError)
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
  it.each([
    ['summary', undefined], ['summary', null], ['summary', 42], ['summary', {}], ['summary', []],
    ['before', undefined], ['before', null], ['before', 42],
    ['after', undefined], ['after', null], ['after', {}],
    ['fireNumber', undefined], ['fireNumber', null], ['fireNumber', 0], ['fireNumber', -1],
    ['fireNumber', 1.5], ['fireNumber', Number.NaN], ['fireNumber', Number.POSITIVE_INFINITY], ['fireNumber', '1'],
    ['probeMs', undefined], ['probeMs', null], ['probeMs', Number.NaN],
    ['probeMs', Number.POSITIVE_INFINITY], ['probeMs', '0'],
  ] as const)('rejects malformed fire field %s=%j before rendering', (field, value) => {
    const legacy = firedEvent('watch-1', '2026-08-12T00:01:00Z').payload
    expect(() => decodeSentinelChange({ ...legacy, fact: { ...legacy.fact, [field]: value } }))
      .toThrow(SentinelLogError)
  })

  it('accepts empty excerpts, fractional nonnegative timings and known structured triggers', () => {
    const legacy = firedEvent('watch-1', '2026-08-12T00:01:00Z').payload
    for (const trigger of [{ kind: 'change' }, { kind: 'webhook' }, { kind: 'pattern', pattern: '准备', match: '' }]) {
      const row = { ...legacy, fact: { ...legacy.fact, summary: '', before: '', after: '', probeMs: 0.25, trigger, state: 'exit 0' } }
      expect(decodeSentinelChange(row)).toEqual(row)
    }
  })

  it('keeps finite legacy timings after a backward wall-clock correction readable', () => {
    const legacy = firedEvent('watch-1', '2026-08-12T00:01:00Z').payload
    const row = { ...legacy, fact: { ...legacy.fact, probeMs: -1000.25 } }
    expect(decodeSentinelChange(row)).toEqual(row)
  })

  it('preserves unknown fire metadata while validating the fields it consumes', () => {
    const legacy = firedEvent('watch-1', '2026-08-12T00:01:00Z').payload
    for (const trigger of [
      { kind: 'change', futureSource: { revision: 2 } },
      { kind: 'pattern', pattern: '准备', match: '准备', futureSource: ['external'] },
    ]) {
      const row = { ...legacy, fact: { ...legacy.fact, trigger, futureMetadata: { language: 'other', values: [1, 'x'] } } }
      expect(decodeSentinelChange(row)).toEqual(row)
    }
  })

  it('keeps legacy fires readable and round-trips optional neutral trigger data', () => {
    const legacy = firedEvent('watch-1', '2026-08-12T00:01:00Z').payload
    expect(decodeSentinelChange(legacy)).toEqual(legacy)
    const current = { ...legacy, fact: { ...legacy.fact, trigger: { kind: 'pattern', pattern: '准备', match: '准备' }, state: 'exit 0' } }
    expect(decodeSentinelChange(current)).toEqual(current)
    for (const trigger of [null, { kind: 'unknown' }, { kind: 'pattern', match: 'x' }, { kind: 'pattern', pattern: 1, match: 'x' }]) {
      expect(() => decodeSentinelChange({ ...legacy, fact: { ...legacy.fact, trigger } })).toThrow(SentinelLogError)
    }
    expect(() => decodeSentinelChange({ ...legacy, fact: { ...legacy.fact, state: 1 } })).toThrow(SentinelLogError)
  })

  it('round-trips session fire triggers and rejects malformed ones', () => {
    const legacy = firedEvent('watch-1', '2026-08-12T00:01:00Z').payload
    const trigger = { kind: 'session', sessionId: 'session-b', turn: 3, reason: 'completed' }
    const row = { ...legacy, fact: { ...legacy.fact, trigger, after: '{"kind":"completed"}' } }
    expect(decodeSentinelChange(row)).toEqual(row)
    for (const bad of [
      { kind: 'session', sessionId: '', turn: 1, reason: 'completed' },
      { kind: 'session', sessionId: 's', turn: -1, reason: 'completed' },
      { kind: 'session', sessionId: 's', turn: 1.5, reason: 'completed' },
      { kind: 'session', sessionId: 's', turn: 1, reason: '' },
      { kind: 'session', sessionId: 's', turn: 1 },
    ]) {
      expect(() => decodeSentinelChange({ ...legacy, fact: { ...legacy.fact, trigger: bad } })).toThrow(SentinelLogError)
    }
  })

  it('round-trips a created session payload', () => {
    const decoded = decodeSentinelChange(createdEvent('watch-4', {
      spec: { kind: 'session', target: 'session-b', pattern: '^completed$', intervalSeconds: 30 },
    }).payload)
    expect(decoded.change).toBe('created')
    if (decoded.change !== 'created') return
    expect(decoded.subscription.spec).toEqual({
      kind: 'session', target: 'session-b', pattern: '^completed$', intervalSeconds: 30,
    })
  })

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
    expect(body).toContain('fired (1/2)')
    expect(body).toContain('服务挂了先看 journalctl 再重启')
    expect(body).toContain('Remaining fires: 1')
    expect(body).toContain("sentinel_cancel")
  })

  it.each(['en', 'zh'] as const)('renders structured triggers and guardrails in %s, preserving notes and snapshots', locale => {
    const fact = { fireNumber: 1, summary: '旧摘要', trigger: { kind: 'change' as const }, state: 'exit 0', before: 'active $&', after: '部署 {note}', probeMs: 1 }
    const body = renderWakeup(sub, fact, locale)
    expect(body).toContain(locale === 'en' ? 'Snapshot changed (state: exit 0)' : '快照发生变化（状态: 退出码 0）')
    expect(body).toContain(locale === 'en' ? 'do not re-register' : '不要重新注册监控')
    expect(body).toContain(sub.note)
    expect(body).toContain(fact.before)
    expect(body).toContain(fact.after)
    expect(body).toContain('sentinel_cancel')
    const terminal = renderWakeup(sub, { ...fact, fireNumber: sub.maxFires }, locale)
    expect(terminal).toContain(locale === 'en' ? 'This was the final fire' : '最后一次触发')
  })

  it('marks the final fire as terminal', () => {
    const body = renderWakeup({ ...sub, fireCount: 1 }, { fireNumber: 2, summary: 's', before: '', after: 'x', probeMs: 1 })
    expect(body).toContain('This was the final fire')
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

describe('planned timeout deadline', () => {
  const deadline = '2026-08-12T00:10:00.000Z'
  const timeoutTrigger = { kind: 'timeout', deadline }

  function compactedTimeout(timeoutAt: string) {
    return {
      type: SENTINEL_CHANGE_TYPE,
      payload: {
        version: SENTINEL_CHANGE_VERSION,
        change: 'compacted',
        subscription: {
          id: 'watch-7',
          spec: { kind: 'file', target: '/tmp/deploy.lock', intervalSeconds: 15 },
          note: 'planned timeout survivor',
          maxFires: 5,
          cooldownSeconds: 60,
          timeoutAt,
          createdAt: '2026-08-12T00:00:00.000Z',
          fireCount: 0,
        },
      },
    }
  }

  it('folds a timeout deadline through created and compacted rows', () => {
    const created = foldSentinelEvents([createdEvent('watch-1', { timeoutAt: deadline })])
    expect(created.active.get('watch-1')?.timeoutAt).toBe(deadline)

    const compacted = foldSentinelEvents([compactedTimeout(deadline)])
    expect(compacted.active.get('watch-7')?.timeoutAt).toBe(deadline)

    // Old rows without the field keep folding: timeout is opt-in.
    const legacy = foldSentinelEvents([createdEvent('watch-2')])
    expect(legacy.active.get('watch-2')?.timeoutAt).toBeUndefined()
  })

  it('rejects a present-but-unparseable timeoutAt in created and compacted rows', () => {
    expect(() => foldSentinelEvents([createdEvent('watch-1', { timeoutAt: 'tomorrow' })])).toThrow(SentinelLogError)
    expect(() => foldSentinelEvents([createdEvent('watch-1', { timeoutAt: 42 })])).toThrow(SentinelLogError)
    expect(() => foldSentinelEvents([compactedTimeout('not-a-date')])).toThrow(SentinelLogError)
  })

  it('decodes a timeout fire trigger and rejects one without a parseable deadline', () => {
    const legacy = firedEvent('watch-1', '2026-08-12T00:10:01.000Z', undefined, timeoutTrigger)
    expect(decodeSentinelChange(legacy.payload)).toEqual(legacy.payload)
    for (const bad of [
      { kind: 'timeout' },
      { kind: 'timeout', deadline: '' },
      { kind: 'timeout', deadline: 'later' },
    ]) {
      expect(() => decodeSentinelChange(firedEvent('watch-1', '2026-08-12T00:10:01.000Z', undefined, bad).payload)).toThrow(SentinelLogError)
    }
  })

  it('retires the watch when the timeout fire is folded, even with budget left', () => {
    const folded = foldSentinelEvents([
      createdEvent('watch-1', { maxFires: 3, timeoutAt: deadline }),
      firedEvent('watch-1', '2026-08-12T00:10:01.000Z', undefined, timeoutTrigger),
    ])
    expect(folded.active.has('watch-1')).toBe(false)
    // The fired row keeps its undelivered entry: boot requeue can still deliver it.
    expect(folded.undeliveredFires).toHaveLength(1)
    expect(folded.undeliveredFires[0]?.fact.trigger).toEqual(timeoutTrigger)

    const delivered = foldSentinelEvents([
      createdEvent('watch-1', { maxFires: 3, timeoutAt: deadline }),
      firedEvent('watch-1', '2026-08-12T00:10:01.000Z', undefined, timeoutTrigger),
      { type: SENTINEL_CHANGE_TYPE, payload: { version: SENTINEL_CHANGE_VERSION, change: 'delivered', at: '2026-08-12T00:10:02.000Z' } },
    ])
    expect(delivered.undeliveredFires).toHaveLength(0)
    expect(delivered.active.size).toBe(0)
  })

  it('keeps a non-timeout fire armed inside the budget', () => {
    const folded = foldSentinelEvents([
      createdEvent('watch-1', { maxFires: 3, timeoutAt: deadline }),
      firedEvent('watch-1', '2026-08-12T00:05:00.000Z'),
    ])
    expect(folded.active.get('watch-1')?.fireCount).toBe(1)
    expect(folded.active.get('watch-1')?.timeoutAt).toBe(deadline)
  })
})

describe('renderTimeoutWakeup', () => {
  const sub: Subscription = {
    id: 'watch-3',
    spec: { kind: 'command', target: 'npm run build', pattern: 'BUILD OK', intervalSeconds: 30 },
    note: '构建超时就先看日志再决定是否重跑',
    maxFires: 2,
    cooldownSeconds: 60,
    timeoutAt: '2026-08-12T00:10:00.000Z',
    createdAt: '2026-08-12T00:00:00.000Z',
    fireCount: 0,
  }
  const fact = {
    fireNumber: 1,
    summary: 'No condition fire before the planned deadline',
    trigger: { kind: 'timeout' as const, deadline: '2026-08-12T00:10:00.000Z' },
    state: 'exit 1',
    before: '',
    after: 'stuck build output',
    probeMs: 0,
  }

  it.each(['en', 'zh'] as const)('renders the deadline, last observation and timeout instruction in %s', locale => {
    const body = renderWakeup(sub, fact, locale)
    expect(body).toContain(locale === 'en' ? 'Watch watch-3 timed out' : '订阅 watch-3 超时未触发')
    expect(body).toContain(sub.timeoutAt!)
    expect(body).toContain(locale === 'en' ? '600s after registration' : '注册后 600s')
    expect(body).toContain(locale === 'en' ? 'No condition fire before the planned deadline (state: exit 1)' : '计划截止时间前未触发（状态: 退出码 1）')
    expect(body).toContain(fact.after)
    expect(body).toContain(sub.note)
    expect(body).toContain(locale === 'en' ? 'sentinel TIMEOUT wakeup' : '哨兵超时唤醒')
    // Timeout is terminal: no fire-budget lines and no "re-register" instruction.
    expect(body).not.toContain(locale === 'en' ? 'final fire' : '最后一次触发')
    expect(body).not.toContain(locale === 'en' ? 'Remaining fires' : '剩余')
    expect(body).not.toContain(locale === 'en' ? 'do not re-register' : '不要重新注册监控')
  })

  it('omits the last-observation block for push-only kinds without a snapshot', () => {
    const body = renderWakeup(
      { ...sub, spec: { kind: 'session', target: 'session-b', intervalSeconds: 30 } },
      { ...fact, state: 'awaiting turn end', after: '' },
      'en',
    )
    expect(body).toContain('awaiting turn end')
    expect(body).not.toContain('Last observation:')
  })
})
