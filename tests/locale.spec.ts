import { describe, expect, it } from 'vitest'
import { createPresentation, formatFireSummary, localizeState, messages, negotiateLocale, resolveLocale, translate, type FireMessage } from '../src/locale.ts'
import { shouldFire } from '../src/sensors.ts'

const cases: ReadonlyArray<{ fact: FireMessage; en: string; zh: string }> = [
  { fact: { summary: '', trigger: { kind: 'change' }, state: 'exit 0' }, en: 'Snapshot changed (state: exit 0)', zh: '快照发生变化（状态: 退出码 0）' },
  { fact: { summary: '', trigger: { kind: 'pattern', pattern: '准备/好', match: '准备好 $& {id}\nnext' } }, en: 'Pattern /准备/好/ started matching: 准备好 $& {id}\nnext', zh: '模式 /准备/好/ 开始匹配: 准备好 $& {id}\nnext' },
  { fact: { summary: '', trigger: { kind: 'webhook' } }, en: 'External push received (webhook)', zh: '外部推送到达（webhook）' },
  { fact: { summary: '', trigger: { kind: 'session', sessionId: 'session-b', turn: 3, reason: 'completed' } }, en: 'Session session-b ended turn 3 (completed)', zh: '会话 session-b 结束了第 3 回合（完成）' },
  { fact: { summary: '', trigger: { kind: 'session', sessionId: 'session-b', turn: 0, reason: 'max-tokens' } }, en: 'Session session-b ended a turn (max-tokens)', zh: '会话 session-b 结束了一个回合（达到输出上限）' },
  { fact: { summary: '', trigger: { kind: 'session', sessionId: 'session-b', turn: 2, reason: 'future-reason' } }, en: 'Session session-b ended turn 2 (future-reason)', zh: '会话 session-b 结束了第 2 回合（future-reason）' },
  { fact: { summary: '', trigger: { kind: 'timeout', deadline: '2026-08-12T00:10:00.000Z' }, state: 'absent' }, en: 'No condition fire before the planned deadline (state: absent)', zh: '计划截止时间前未触发（状态: 不存在）' },
  { fact: { summary: '', trigger: { kind: 'timeout', deadline: '2026-08-12T00:10:00.000Z' } }, en: 'No condition fire before the planned deadline', zh: '计划截止时间前未触发' },
  { fact: { summary: '快照发生变化（状态: exit 0）' }, en: 'Snapshot changed (state: exit 0)', zh: '快照发生变化（状态: 退出码 0）' },
  { fact: { summary: '模式 /ready/ 开始匹配: ready（状态: HTTP 200）' }, en: 'Pattern /ready/ started matching: ready (state: HTTP 200)', zh: '模式 /ready/ 开始匹配: ready（状态: HTTP 200）' },
  { fact: { summary: '外部推送到达（webhook）' }, en: 'External push received (webhook)', zh: '外部推送到达（webhook）' },
  { fact: { summary: 'Snapshot changed (state: closed (db:5432))' }, en: 'Snapshot changed (state: closed (db:5432))', zh: '快照发生变化（状态: 端口不通 (db:5432)）' },
  { fact: { summary: '自定义 user summary（状态: private）' }, en: '自定义 user summary（状态: private）', zh: '自定义 user summary（状态: private）' },
]

describe('presentation locale', () => {
  it('normalizes supported tags with an English fallback', () => {
    for (const tag of [undefined, '', 'en', 'en-US', 'ru-RU', 'zhang', '<script>']) expect(resolveLocale(tag)).toBe('en')
    for (const tag of ['zh', 'zh-CN', 'zh-TW', 'ZH-hans']) expect(resolveLocale(tag)).toBe('zh')
  })

  it.each([
    ['zh-CN;q=0,en-US;q=1', 'en'],
    ['en;q=0.1,zh;q=1', 'zh'],
    ['fr,zh;q=0.9', 'zh'],
    ['en;q=0.7,zh;q=0.7', 'en'],
    ['zh;q=0.7,en;q=0.7', 'zh'],
    [' zh-Hant ; q=0.9, EN-us;q=0.5 ', 'zh'],
    ['zh;q=garbage,en;q=0.9', 'en'],
    ['zh;q=1.5,en;q=0.5', 'en'],
    ['en;q=0,*;q=1', 'zh'],
    ['zh;q=0,*;q=1', 'en'],
    ['*', 'zh'],
    ['ru-RU', 'en'],
    ['en;q=0,zh;q=0', 'en'],
  ] as const)('negotiates weighted dashboard preferences %s', (header, expected) => {
    expect(negotiateLocale(header, 'zh')).toBe(expected)
  })

  it('uses server locale only when no request preference is supplied', () => {
    expect(negotiateLocale(undefined, 'zh')).toBe('zh')
    expect(negotiateLocale('  ', 'zh')).toBe('zh')
    expect(negotiateLocale(undefined)).toBe('en')
  })

  it('keeps dictionary keys and interpolation placeholders balanced', () => {
    expect(Object.keys(messages.en).sort()).toEqual(Object.keys(messages.zh).sort())
    for (const key of Object.keys(messages.en) as Array<keyof typeof messages.en>) {
      const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
      expect(placeholders(messages.en[key]), key).toEqual(placeholders(messages.zh[key]))
    }
    expect(translate('en', 'cancelled', { id: '$& {note}' })).toBe('Watch $& {note} cancelled.')
  })

  it.each(cases)('formats current and legacy events without changing caller-owned text: $en', ({ fact, en, zh }) => {
    const original = JSON.stringify(fact)
    expect(formatFireSummary(fact, 'en')).toBe(en)
    expect(formatFireSummary(fact, 'zh')).toBe(zh)
    expect(JSON.stringify(fact)).toBe(original)
  })

  it('localizes only known state labels, not raw snapshots or unknown states', () => {
    expect(localizeState('exists (12 bytes)', 'zh')).toBe('存在（12 字节）')
    expect(localizeState('3 process(es)', 'zh')).toBe('3 个进程')
    expect(localizeState('awaiting turn end', 'zh')).toBe('等待回合结束')
    expect(localizeState('turn ended (completed)', 'zh')).toBe('回合已结束（完成）')
    expect(localizeState('turn ended (future-reason)', 'zh')).toBe('回合已结束（future-reason）')
    expect(localizeState('awaiting turn end', 'en')).toBe('awaiting turn end')
    for (const state of ['HTTP 500', 'openly custom', 'exists unexpected', 'exit custom', 'size=12 mtime=1\n准备']) {
      expect(localizeState(state, 'zh')).toBe(state)
    }
    expect(localizeState('exists (12 bytes)', 'en')).toBe('exists (12 bytes)')
  })

  it('does not guess ambiguous legacy boundaries inside regexes or matched text', () => {
    const summaries = [
      '模式 /ready/ 开始匹配: ready / 开始匹配: payload（状态: exit 0）',
      'Pattern /ready/ started matching: ready / started matching: payload (state: exit 0)',
      '模式 /a/ 开始匹配: b/ 开始匹配: payload',
    ]
    for (const summary of summaries) {
      expect(formatFireSummary({ summary }, 'en')).toBe(summary)
      expect(formatFireSummary({ summary }, 'zh')).toBe(summary)
    }
    const match = 'ready / 开始匹配: payload'
    expect(formatFireSummary({ summary: '', trigger: { kind: 'pattern', pattern: 'ready', match } }, 'en'))
      .toBe(`Pattern /ready/ started matching: ${match}`)
  })

  it('uses the same typed formatters for each presentation entry point', () => {
    for (const locale of ['en', 'zh'] as const) {
      const presentation = createPresentation(locale, messages[locale])
      for (const { fact } of cases) expect(presentation.formatFireSummary(fact)).toBe(formatFireSummary(fact, locale))
    }
  })

  it('emits neutral trigger data without changing transition or snapshot semantics', () => {
    expect(shouldFire(undefined, 'exit=0\nold', 'exit=0\nnew')).toEqual({ fire: true, summary: 'Snapshot changed', trigger: { kind: 'change' } })
    const result = shouldFire('准备', '<absent>', 'size=6 mtime=1\n准备')
    expect(result.trigger).toEqual({ kind: 'pattern', pattern: '准备', match: '准备' })
    expect(result.summary).toBe('Pattern /准备/ started matching: 准备')
    expect(shouldFire('[\\s\\S]+', undefined, '<absent>').fire).toBe(false)
  })
})
