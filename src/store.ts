/**
 * Plugin-owned durable log. The host's session log REFUSES foreign event
 * types on the cold read path (`KNOWN_SESSION_EVENT_TYPES` in
 * `dsh-session/known-event-types`: "a registration surface for plugin events
 * is deferred until such a consumer exists"), so sentinel state lives in a
 * sidecar JSONL under the harness home instead: one line per change, grouped
 * by session, folded on load — the same event-sourcing discipline, our own
 * file.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  decodeSentinelChange,
  SENTINEL_CHANGE_TYPE,
  SENTINEL_CHANGE_VERSION,
  type SentinelChange,
} from './domain.ts'

/** One persisted sidecar row: a sentinel change bound to its session. */
export interface StoreRow {
  readonly sessionId: string
  readonly change: SentinelChange
}

/** Event-row shape `foldSentinelEvents` consumes. */
export interface FoldableRow {
  readonly type: string
  readonly payload?: unknown
}

/**
 * Append-only JSONL store. Writes are chained so rows land in order; reads
 * tolerate a torn final line (crash mid-append) by dropping it.
 */
export class SentinelStore {
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  /** Load and group every persisted change; corrupt full lines throw, a torn tail is dropped. */
  async load(): Promise<Map<string, FoldableRow[]>> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'ENOENT') return new Map()
      throw error
    }
    const rows = new Map<string, FoldableRow[]>()
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      if (line.trim() === '') continue
      let parsed: { sessionId?: unknown; change?: unknown }
      try {
        parsed = JSON.parse(line) as { sessionId?: unknown; change?: unknown }
      } catch (error: unknown) {
        // Only the final line may be torn (crash mid-append); anything else is corruption.
        if (index >= lines.length - 2) break
        throw error
      }
      if (typeof parsed.sessionId !== 'string') continue
      const change = decodeSentinelChange(parsed.change)
      const list = rows.get(parsed.sessionId) ?? []
      list.push({ type: SENTINEL_CHANGE_TYPE, payload: change })
      rows.set(parsed.sessionId, list)
    }
    return rows
  }

  /** Durably append one change; resolves after the write lands. */
  append(sessionId: string, change: SentinelChange): Promise<void> {
    const line = `${JSON.stringify({ v: SENTINEL_CHANGE_VERSION, sessionId, change })}\n`
    const next = this.chain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, line, 'utf8')
    })
    // Keep the chain alive after a failed write; the caller sees the rejection.
    this.chain = next.catch(() => {})
    return next
  }
}
