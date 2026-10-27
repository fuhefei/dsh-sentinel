import { useSyncExternalStore } from 'react'
import type { LocaleRuntime, LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import type { Locale } from '../locale.ts'

/** Stable React subscription boundary for the host's active locale and revisions. */
export function createClientLocaleSource(runtime: Pick<LocaleRuntime, 'getSnapshot' | 'subscribe'>) {
  return {
    getSnapshot: () => runtime.getSnapshot(),
    subscribe: (listener: () => void) => runtime.subscribe(listener),
  }
}

export type ClientLocaleSource = ReturnType<typeof createClientLocaleSource>

/** Match the host's dictionary fallback chain, not the active language tag's prefix. */
export function resolveClientLocale(snapshot: Pick<LocaleSnapshot, 'active' | 'locales'>): Locale {
  const definitionFor = (id: string) => snapshot.locales.find(definition => definition.id.toLowerCase() === id.toLowerCase())
  let current = definitionFor(snapshot.active)
  const visited = new Set<string>()
  while (current !== undefined && !visited.has(current.id.toLowerCase())) {
    const id = current.id.toLowerCase()
    if (id === 'en' || id === 'zh') return id
    visited.add(id)
    current = current.fallback === undefined ? undefined : definitionFor(current.fallback)
  }
  // The host validates catalogs; an unload gap or malformed external snapshot stays safe.
  return 'en'
}

/** The better-sidebar contract has no locale seat; subscribe to the host instead. */
export function useClientLocale(source: ClientLocaleSource): Locale {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  return resolveClientLocale(snapshot)
}
