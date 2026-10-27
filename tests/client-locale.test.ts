import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import type { ReactElement, ReactNode } from 'react'
import { createClientLocaleSource, resolveClientLocale } from '../src/client/locale.ts'
import { apply } from '../src/client/index.tsx'
import { createPoller } from '../src/client/poller.ts'

const fixtures = vi.hoisted(() => ({
  watches: [{
    sessionId: 'session-1', live: true, id: 'watch-1', kind: 'file', target: '/tmp/用户.txt',
    intervalSeconds: 30, note: '用户提供的便签', fireCount: 1, maxFires: 2, lastState: 'absent',
  }],
  recentFires: [{
    sessionId: 'session-1', id: 'watch-1', at: '2026-01-01T01:02:03.000Z',
    summary: '模式 /READY/ 开始匹配: READY（状态: absent）',
    trigger: { kind: 'pattern' as const, pattern: 'READY', match: 'READY' }, state: 'absent',
    note: '用户提供的便签', before: '原始快照', after: 'READY 用户数据',
  }, {
    sessionId: 'session-1', id: 'legacy-watch', at: '2025-12-01T01:02:03.000Z',
    summary: '快照发生变化（状态: absent）',
    note: 'legacy note', before: 'old data', after: 'new data',
  }],
}))

// Evaluate the component tree without adding a DOM/test-renderer dependency.
// Hooks are controlled here; the actual components, host bindings and formatters run.
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: vi.fn(),
  useState: (initial: unknown) => [
    typeof initial === 'boolean' ? true
      : typeof initial === 'object' && initial !== null && 'watches' in initial ? fixtures : initial,
    vi.fn(),
  ],
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ StateDot: () => null }))
vi.mock('../src/client/poller.ts', () => ({
  createPoller: vi.fn(() => ({ running: false, start: vi.fn(), stop: vi.fn() })),
}))

interface View {
  text: string
  hrefs: string[]
}

function render(node: ReactNode): View {
  if (node === null || node === undefined || typeof node === 'boolean') return { text: '', hrefs: [] }
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node), hrefs: [] }
  if (Array.isArray(node)) {
    const children = node.map(render)
    return { text: children.map(child => child.text).join(''), hrefs: children.flatMap(child => child.hrefs) }
  }
  const element = node as ReactElement<{ children?: ReactNode; href?: string }>
  if (typeof element.type === 'function') {
    return render((element.type as (props: typeof element.props) => ReactNode)(element.props))
  }
  const result = render(element.props.children)
  if (element.props.href !== undefined) result.hrefs.push(element.props.href)
  return result
}

function host(active = 'en', locales: LocaleSnapshot['locales'] = [
  { id: 'en', label: 'English' }, { id: 'zh', label: '中文', fallback: 'en' },
]) {
  let snapshot: LocaleSnapshot = { active, locales, revision: 0 }
  let dictionaries: Record<string, Record<string, string>> = {}
  const listeners = new Set<() => void>()
  const locale = {
    getSnapshot() { return snapshot },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    register: vi.fn((_namespace, dicts: typeof dictionaries) => { dictionaries = dicts; return () => {} }),
    bind: vi.fn(() => (key: string, values: Record<string, unknown> = {}) => {
      let id: string | undefined = snapshot.active
      const visited = new Set<string>()
      let template: string | undefined
      while (id !== undefined && !visited.has(id)) {
        visited.add(id)
        template = dictionaries[id]?.[key]
        if (template !== undefined) break
        id = snapshot.locales.find(definition => definition.id === id)?.fallback
      }
      return (template ?? dictionaries.en![key]!).replace(/\{(\w+)\}/g, (token, name: string) =>
        values[name] === undefined ? token : String(values[name]))
    }),
  }
  const slots = new Map<string, { spec: { label?: () => string }; component: (props: object) => ReactNode }>()
  let tab: { title: () => string; component: () => ReactNode }
  const ctx = {
    locale,
    effect: (callback: () => unknown) => callback(),
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (spec: { name: string; label?: () => string }, component: (props: object) => ReactNode) => {
        slots.set(spec.name, { spec, component })
      },
    },
    plugin: ({ apply: activate }: { apply: (context: object) => void }) => activate({
      betterSidebar: { registerTab: (descriptor: typeof tab) => { tab = descriptor; return () => {} } },
    }),
  }
  apply(ctx as unknown as Context)
  return {
    locale, slots,
    get tab() { return tab! },
    t: locale.bind(),
    setLocale(next: string) {
      snapshot = { ...snapshot, active: next, revision: snapshot.revision + 1 }
      for (const listener of listeners) listener()
    },
    setLocales(locales: LocaleSnapshot['locales']) {
      snapshot = { ...snapshot, locales, revision: snapshot.revision + 1 }
      for (const listener of listeners) listener()
    },
    get listenerCount() { return listeners.size },
  }
}

const pollGlobalState = vi.mocked(createPoller).mock.calls[0]![0].run

beforeEach(async () => {
  vi.stubGlobal('navigator', { language: 'zh-CN' })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => fixtures })))
  // Populate the real shared global-watch store without arming timers.
  await pollGlobalState(new AbortController().signal)
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('client host locale', () => {
  it.each([
    { active: 'zh-CN', locales: [{ id: 'zh-CN', label: 'Chinese variant', fallback: 'en' }], expected: 'en' },
    { active: 'ZH-Hans', locales: [{ id: 'zh-Hans', label: 'Chinese variant', fallback: 'en' }], expected: 'en' },
    { active: 'RU', locales: [{ id: 'ru', label: 'Russian', fallback: 'ZH' }, { id: 'zh', label: 'Chinese', fallback: 'en' }], expected: 'zh' },
    { active: 'zh', locales: [], expected: 'en' },
    { active: 'missing', locales: [], expected: 'en' },
    { active: 'ru', locales: [{ id: 'ru', label: 'Russian', fallback: 'missing' }], expected: 'en' },
    { active: 'ru', locales: [{ id: 'ru', label: 'Russian', fallback: 'fr' }, { id: 'fr', label: 'French', fallback: 'ru' }], expected: 'en' },
  ])('uses catalog fallback safely for $active: $locales', ({ active, locales, expected }) => {
    expect(resolveClientLocale({ active, locales })).toBe(expected)
  })

  it('delegates stable snapshots, revisions and unsubscribe to the host', () => {
    const client = host()
    const source = createClientLocaleSource(client.locale)
    expect(source.getSnapshot()).toBe(client.locale.getSnapshot())
    const notify = vi.fn()
    const dispose = source.subscribe(notify)
    client.setLocale('zh')
    expect(notify).toHaveBeenCalledOnce()
    expect(source.getSnapshot().active).toBe('zh')
    dispose()
    expect(client.listenerCount).toBe(0)
    client.setLocale('en')
    expect(notify).toHaveBeenCalledOnce()
  })

  it('uses English host copy for sidebar title and body despite a Chinese browser', () => {
    const client = host('en')
    expect(client.tab.title()).toBe('Sentinel')
    expect(client.slots.get('sidebar.panellist')!.spec.label!()).toBe('Sentinel')
    const body = render(client.tab.component())
    expect(body.text).toContain('Recent fires')
    expect(body.text).toContain('Pattern /READY/ started matching: READY (state: absent)')
    expect(body.text).toContain('Snapshot changed (state: absent)')
    expect(body.text).toContain('note: 用户提供的便签')
    expect(body.text).toContain('原始快照')
    expect(body.text).not.toContain('开始匹配')
    expect(body.hrefs).toContain('/plugins/dsh-sentinel/dashboard?lang=en')
  })

  it('switches the same mounted tab bindings to Chinese, independent of browser language', () => {
    vi.stubGlobal('navigator', { language: 'en-US' })
    const client = host('en')
    const component = client.tab.component
    client.setLocale('zh')
    expect(client.tab.title()).toBe('哨兵监控')
    const body = render(component())
    expect(body.text).toContain('最近触发')
    expect(body.text).toContain('模式 /READY/ 开始匹配: READY（状态: 不存在）')
    expect(body.text).toContain('便签：用户提供的便签')
    expect(body.text).toContain('不存在 · 触发 1/2')
    expect(body.hrefs).toContain('/plugins/dsh-sentinel/dashboard?lang=zh')
  })

  it('follows a language pack fallback chain consistently across every client surface', () => {
    const client = host('ru', [
      { id: 'en', label: 'English' }, { id: 'zh', label: '中文', fallback: 'en' },
      { id: 'ru', label: 'Русский', fallback: 'fr' }, { id: 'fr', label: 'Français', fallback: 'en' },
    ])
    const tab = client.tab.component
    expect(render(tab()).text).toContain('Snapshot changed (state: absent)')
    client.setLocales([
      { id: 'en', label: 'English' }, { id: 'zh', label: '中文', fallback: 'en' },
      { id: 'ru', label: 'Русский', fallback: 'fr' }, { id: 'fr', label: 'Français', fallback: 'zh' },
    ])
    expect(client.tab.title()).toBe('哨兵监控')
    const time = vi.spyOn(Date.prototype, 'toLocaleTimeString').mockReturnValue('01:02:03')
    const views = [render(tab()), ...['conversation.input.dock', 'main'].map(name =>
      render(client.slots.get(name)!.component({ t: client.t, session: { sessionId: 'session-1' } })))]
    for (const view of views) {
      expect(view.text).toContain('最近触发')
      expect(view.text).toContain('模式 /READY/ 开始匹配: READY（状态: 不存在）')
      expect(view.text).toContain('不存在 · 触发 1/2')
      expect(view.hrefs).toContain('/plugins/dsh-sentinel/dashboard?lang=zh')
    }
    expect(time).toHaveBeenCalledWith('zh')
  })

  it('localizes dock and main-panel fire history and passes host locale to time formatting', () => {
    const client = host('en')
    const time = vi.spyOn(Date.prototype, 'toLocaleTimeString').mockReturnValue('01:02:03')
    for (const name of ['conversation.input.dock', 'main']) {
      const view = render(client.slots.get(name)!.component({ t: client.t, session: { sessionId: 'session-1' } }))
      expect(view.text).toContain('Pattern /READY/ started matching: READY (state: absent)')
      expect(view.text).toContain('READY 用户数据')
      expect(view.hrefs).toContain('/plugins/dsh-sentinel/dashboard?lang=en')
    }
    expect(time).toHaveBeenCalledWith('en')
  })
})
