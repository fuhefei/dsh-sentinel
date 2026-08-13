/**
 * Client-side standalone-build shims: every import here is served by the
 * shell's frozen platform module table at runtime (tsdown marks them
 * external); these loose declarations exist only so `tsc -b` passes outside
 * the dsh workspace.
 */
declare module 'cordis' {
  export interface Context {
    effect(body: () => (() => void) | void, label?: string): void
    locale: { register(ns: string, dictionaries: Record<string, Record<string, string>>): void }
    slots: {
      inject(name: string, register: () => unknown): void
      register(row: { name: string; id: string; order?: number; locale?: string }, component: unknown): unknown
    }
  }
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactNode } from 'react'
  export function StateDot(props: { state: string; size?: number }): ReactNode
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  export interface LocaleNamespaceMap {}
  export type PropsRuntime<Name extends string> = {
    session: { sessionId: string }
  } & { __slot?: Name }
  export type PropsLocale<NS extends keyof LocaleNamespaceMap | string> = {
    t: (key: NS extends keyof LocaleNamespaceMap ? LocaleNamespaceMap[NS] : string, values?: Record<string, unknown>) => string
  }
}

declare module '@deepseek-ai/dsh-client-runtime/client' {}
declare module '@deepseek-ai/dsh-client-locale/client' {}
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {}
