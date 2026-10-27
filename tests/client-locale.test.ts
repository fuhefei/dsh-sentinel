import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import { createElement, type ComponentType, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer'
import { createClientLocaleSource, resolveClientLocale } from '../src/client/locale.ts'
import { apply } from '../src/client/index.tsx'

const fixtures = {
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
}

// Keep the host primitive outside this test; React hooks and Sentinel pollers are real.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ StateDot: () => null }))

const mounted = new Set<ReactTestRenderer>()
const hosts: Array<{ readonly listenerCount: number; dispose(): void }> = []
const disconnect = vi.fn()

async function mount(element: ReactElement): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(element)
    mounted.add(renderer)
  })
  return renderer
}

async function unmount(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => { renderer.unmount() })
  mounted.delete(renderer)
}

function textOf(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node === null) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children ?? []).map(textOf).join('')
}

function view(renderer: ReactTestRenderer) {
  return {
    text: textOf(renderer.toJSON()),
    hrefs: renderer.root.findAllByType('a').map(link => link.props.href as string),
  }
}

async function expandFires(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    for (const row of renderer.root.findAll(node => node.type === 'div'
      && typeof node.props.onMouseEnter === 'function' && typeof node.props.onClick === 'function')) {
      row.props.onClick()
    }
  })
}

function host(active = 'en', locales: LocaleSnapshot['locales'] = [
  { id: 'en', label: 'English' }, { id: 'zh', label: '中文', fallback: 'en' },
]) {
  let snapshot: LocaleSnapshot = { active, locales, revision: 0 }
  let dictionaries: Record<string, Record<string, string>> = {}
  const listeners = new Set<() => void>()
  const disposers: Array<() => void> = []
  const locale = {
    getSnapshot() { return snapshot },
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }),
    register: vi.fn((_namespace, dicts: typeof dictionaries) => {
      dictionaries = dicts
      return () => { dictionaries = {} }
    }),
    bind: vi.fn(() => (key: string, values: Record<string, unknown> = {}) => {
      const definitionFor = (id: string) => snapshot.locales.find(definition => definition.id.toLowerCase() === id.toLowerCase())
      let current = definitionFor(snapshot.active)
      const visited = new Set<string>()
      let template: string | undefined
      while (current !== undefined && !visited.has(current.id.toLowerCase())) {
        const id = current.id.toLowerCase()
        visited.add(id)
        template = dictionaries[id]?.[key]
        if (template !== undefined) break
        current = current.fallback === undefined ? undefined : definitionFor(current.fallback)
      }
      return (template ?? dictionaries.en![key]!).replace(/\{(\w+)\}/g, (token, name: string) =>
        values[name] === undefined ? token : String(values[name]))
    }),
  }
  const slots = new Map<string, { spec: { label?: () => string }; component: ComponentType<Record<string, unknown>> }>()
  let tab: { title: () => string; component: ComponentType }
  const ctx = {
    locale,
    effect: (callback: () => (() => void) | void) => {
      const dispose = callback()
      if (dispose !== undefined) disposers.push(dispose)
      return dispose
    },
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (spec: { name: string; label?: () => string }, component: ComponentType<Record<string, unknown>>) => {
        slots.set(spec.name, { spec, component })
        return () => { slots.delete(spec.name) }
      },
    },
    plugin: ({ apply: activate }: { apply: (context: object) => void }) => activate({
      betterSidebar: { registerTab: (descriptor: typeof tab) => { tab = descriptor; return () => {} } },
    }),
  }
  apply(ctx as unknown as Context)
  const result = {
    locale, slots,
    get tab() { return tab! },
    t: locale.bind(),
    setLocale(next: string) {
      snapshot = { ...snapshot, active: next, revision: snapshot.revision + 1 }
      for (const listener of listeners) listener()
    },
    setLocales(next: LocaleSnapshot['locales']) {
      snapshot = { ...snapshot, locales: next, revision: snapshot.revision + 1 }
      for (const listener of listeners) listener()
    },
    get listenerCount() { return listeners.size },
    dispose() { for (const dispose of disposers.splice(0).reverse()) dispose() },
  }
  hosts.push(result)
  return result
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(new Date('2026-01-01T01:02:03.000Z'))
  vi.stubGlobal('navigator', { language: 'zh-CN' })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => fixtures })))
  vi.stubGlobal('document', { body: {}, querySelector: () => ({}) })
  vi.stubGlobal('MutationObserver', class {
    observe() {}
    disconnect() { disconnect() }
  })
  disconnect.mockClear()
})
afterEach(async () => {
  await act(async () => { for (const renderer of mounted) renderer.unmount() })
  mounted.clear()
  for (const client of hosts.splice(0)) {
    expect(client.listenerCount).toBe(0)
    client.dispose()
  }
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

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

  it('uses English host copy despite a Chinese browser and preserves expanded user data', async () => {
    const client = host('en')
    expect(client.tab.title()).toBe('Sentinel')
    expect(client.slots.get('sidebar.panellist')!.spec.label!()).toBe('Sentinel')
    const renderer = await mount(createElement(client.tab.component))
    await expandFires(renderer)
    const body = view(renderer)
    expect(body.text).toContain('Recent fires')
    expect(body.text).toContain('Pattern /READY/ started matching: READY (state: absent)')
    expect(body.text).toContain('Snapshot changed (state: absent)')
    expect(body.text).toContain('note: 用户提供的便签')
    expect(body.text).toContain('原始快照')
    expect(body.text).not.toContain('开始匹配')
    expect(body.hrefs).toContain('/plugins/dsh-sentinel/dashboard?lang=en')
  })

  it('updates one mounted tab on locale notifications without replacing it or resubscribing', async () => {
    vi.stubGlobal('navigator', { language: 'en-US' })
    const client = host('en')
    const renderer = await mount(createElement(client.tab.component))
    await expandFires(renderer)
    expect(client.listenerCount).toBe(1)
    expect(client.locale.subscribe).toHaveBeenCalledOnce()
    expect(view(renderer).text).toContain('Recent fires')
    await act(async () => { client.setLocale('zh') })
    expect(client.tab.title()).toBe('哨兵监控')
    const body = view(renderer)
    expect(body.text).toContain('最近触发')
    expect(body.text).toContain('模式 /READY/ 开始匹配: READY（状态: 不存在）')
    expect(body.text).toContain('便签：用户提供的便签')
    expect(body.text).toContain('不存在 · 触发 1/2')
    expect(body.hrefs).toContain('/plugins/dsh-sentinel/dashboard?lang=zh')
    expect(client.locale.subscribe).toHaveBeenCalledOnce()
    await unmount(renderer)
    expect(client.listenerCount).toBe(0)
  })

  it('updates mounted surfaces when only fallback definitions change, retaining active locale', async () => {
    const client = host('ru', [
      { id: 'en', label: 'English' }, { id: 'zh', label: '中文', fallback: 'en' },
      { id: 'ru', label: 'Русский', fallback: 'fr' }, { id: 'fr', label: 'Français', fallback: 'en' },
    ])
    const renderers = [await mount(createElement(client.tab.component))]
    for (const name of ['conversation.input.dock', 'main']) {
      renderers.push(await mount(createElement(client.slots.get(name)!.component, { t: client.t, session: { sessionId: 'session-1' } })))
    }
    for (const renderer of renderers) expect(view(renderer).text).toContain('Snapshot changed (state: absent)')
    const time = vi.spyOn(Date.prototype, 'toLocaleTimeString').mockReturnValue('01:02:03')
    await act(async () => { client.setLocales([
      { id: 'en', label: 'English' }, { id: 'zh', label: '中文', fallback: 'en' },
      { id: 'ru', label: 'Русский', fallback: 'fr' }, { id: 'fr', label: 'Français', fallback: 'zh' },
    ]) })
    expect(client.locale.getSnapshot().active).toBe('ru')
    expect(client.tab.title()).toBe('哨兵监控')
    for (const renderer of renderers) {
      const body = view(renderer)
      expect(body.text).toContain('最近触发')
      expect(body.text).toContain('模式 /READY/ 开始匹配: READY（状态: 不存在）')
      expect(body.text).toContain('不存在 · 触发 1/2')
      expect(body.hrefs).toContain('/plugins/dsh-sentinel/dashboard?lang=zh')
    }
    expect(time).toHaveBeenCalledWith('zh')
  })

  it('localizes mounted dock and main-panel history and passes the host locale to time formatting', async () => {
    const client = host('en')
    const time = vi.spyOn(Date.prototype, 'toLocaleTimeString').mockReturnValue('01:02:03')
    for (const name of ['conversation.input.dock', 'main']) {
      const renderer = await mount(createElement(client.slots.get(name)!.component, { t: client.t, session: { sessionId: 'session-1' } }))
      await expandFires(renderer)
      const body = view(renderer)
      expect(body.text).toContain('Pattern /READY/ started matching: READY (state: absent)')
      expect(body.text).toContain('READY 用户数据')
      expect(body.hrefs).toContain('/plugins/dsh-sentinel/dashboard?lang=en')
    }
    expect(time).toHaveBeenCalledWith('en')
  })

  it('releases locale listeners, shared polling and dock observers as real components unmount', async () => {
    const client = host('en')
    const tab = await mount(createElement(client.tab.component))
    const panel = await mount(createElement(client.slots.get('main')!.component, { t: client.t }))
    const dock = await mount(createElement(client.slots.get('conversation.input.dock')!.component, { t: client.t, session: { sessionId: 'session-1' } }))
    expect(client.listenerCount).toBe(3)
    expect(fetch).toHaveBeenCalledTimes(2)
    await unmount(tab)
    expect(client.listenerCount).toBe(2)
    await act(async () => { client.setLocale('zh') })
    expect(view(panel).text).toContain('最近触发')
    expect(view(dock).text).toContain('最近触发')
    await unmount(panel)
    expect(client.listenerCount).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    await unmount(dock)
    expect(client.listenerCount).toBe(0)
    expect(disconnect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
