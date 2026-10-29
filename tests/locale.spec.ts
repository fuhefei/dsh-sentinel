import { describe, expect, it } from 'vitest'
import { createPresentation, formatFireSummary, localizeState, messages, negotiateLocale, resolveLocale, translate, type FireMessage } from '../src/locale.ts'
import { shouldFire } from '../src/sensors.ts'

const cases: ReadonlyArray<{ fact: FireMessage; en: string; zh: string }> = [
  { fact: { summary: '', trigger: { kind: 'change' }, state: 'exit 0' }, en: 'Snapshot changed (state: exit 0)', zh: '快照发生变化（状态: 退出码 0）' },
  { fact: { summary: '', trigger: { kind: 'pattern', pattern: '准备/好', match: '准备好 $& {id}\nnext' } }, en: 'Pattern /准备/好/ started matching: 准备好 $& {id}\nnext', zh: '模式 /准备/好/ 开始匹配: 准备好 $& {id}\nnext' },
  { fact: { summary: '', trigger: { kind: 'webhook' } }, en: 'External push received (webhook)', zh: '外部推送到达（webhook）' },
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
