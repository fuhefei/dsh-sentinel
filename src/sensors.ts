/**
 * Sensor probes: one async function per SensorKind that captures a text
 * snapshot of the watched thing. The runtime diffs consecutive snapshots (and
 * applies the optional pattern) to decide whether a subscription fires.
 *
 * All probes are read-only by construction: file stat/read, HTTP GET, process
 * listing, and — the one deliberate power tool — a shell command the agent
 * already had permission to run interactively when it registered the watch.
 */
import { exec, execFile } from 'node:child_process'
import { connect } from 'node:net'
import { open, stat } from 'node:fs/promises'
import type { SensorSpec } from './domain.ts'

export interface ProbeResult {
  /** Canonical snapshot text (diffed against the previous probe). */
  readonly snapshot: string
  /** One-line state label used in transition summaries. */
  readonly state: string
}

const PROBE_TIMEOUT_MS = 10_000
const SNAPSHOT_TAIL_BYTES = 8192

/**
 * Placeholder snapshots mean "the target itself is missing/unreachable", not
 * content. Patterns must never match them: an any-content regex like [\s\S]+
 * would otherwise fire on the very first probe of an absent file.
 */
const PLACEHOLDER_ABSENT = '<absent>'
const PLACEHOLDER_UNREACHABLE = '<unreachable>'
const PLACEHOLDER_NONE = '<none>'
const PLACEHOLDER_PUSH_ONLY = '<push-only>'

export function isPlaceholderSnapshot(snapshot: string): boolean {
  return snapshot === PLACEHOLDER_ABSENT
    || snapshot === PLACEHOLDER_UNREACHABLE
    || snapshot === PLACEHOLDER_NONE
    || snapshot === PLACEHOLDER_PUSH_ONLY
}

/** Read the tail of a file plus its identity line; missing file is a state, not an error. Only the trailing bytes are read, so huge files cost a bounded buffer. */
async function probeFile(target: string): Promise<ProbeResult> {
  try {
    const info = await stat(target)
    let tail = ''
    if (info.isFile() && info.size > 0) {
      const length = Math.min(Number(info.size), SNAPSHOT_TAIL_BYTES)
      const buffer = Buffer.alloc(length)
      const handle = await open(target, 'r')
      try {
        // Positioned at the tail; a concurrent grow shortens the read, never misaligns it.
        await handle.read(buffer, 0, length, Number(info.size) - length)
      } finally {
        await handle.close()
      }
      tail = buffer.toString('utf8')
    }
    return {
      snapshot: `size=${String(info.size)} mtime=${info.mtimeMs.toFixed(0)}\n${tail}`,
      state: `exists (${String(info.size)} bytes)`,
    }
  } catch {
    return { snapshot: PLACEHOLDER_ABSENT, state: 'absent' }
  }
}

/** Run a read-only command line; snapshot = exit code + combined output tail. */
function probeCommand(target: string): Promise<ProbeResult> {
  return new Promise(resolve => {
    exec(target, { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : (typeof error.code === 'number' ? error.code : 1)
      const text = `${stdout}${stderr === '' ? '' : `\n${stderr}`}`.trim()
      const tail = text.length > SNAPSHOT_TAIL_BYTES ? text.slice(-SNAPSHOT_TAIL_BYTES) : text
      resolve({
        snapshot: `exit=${String(code)}\n${tail}`,
        state: `exit ${String(code)}`,
      })
    })
  })
}

/** GET the URL; snapshot = status + body head, streamed so a huge body never lands whole in memory. Network failure is a state. */
async function probeHttp(target: string): Promise<ProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(target, { signal: controller.signal, redirect: 'manual' })
    let head = ''
    const reader = response.body?.getReader()
    if (reader !== undefined) {
      const decoder = new TextDecoder()
      while (head.length < SNAPSHOT_TAIL_BYTES) {
        const { done, value } = await reader.read()
        if (done) break
        head += decoder.decode(value, { stream: true })
      }
      // Enough bytes collected (or the loop exited early): release the connection.
      void reader.cancel().catch(() => {})
    } else {
      head = await response.text()
    }
    if (head.length > SNAPSHOT_TAIL_BYTES) head = head.slice(0, SNAPSHOT_TAIL_BYTES)
    return {
      snapshot: `status=${String(response.status)}\n${head}`,
      state: `HTTP ${String(response.status)}`,
    }
  } catch {
    return { snapshot: PLACEHOLDER_UNREACHABLE, state: 'unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

/** List matching processes via pgrep; snapshot = sorted pid/cmd lines. */
function probeProcess(target: string): Promise<ProbeResult> {
  return new Promise(resolve => {
    execFile('pgrep', ['-af', target], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (_error, stdout) => {
      const lines = stdout.split('\n').filter(line => line.trim() !== '').sort()
      if (lines.length === 0) {
        resolve({ snapshot: PLACEHOLDER_NONE, state: 'no process' })
        return
      }
      resolve({
        snapshot: lines.join('\n'),
        state: `${String(lines.length)} process(es)`,
      })
    })
  })
}

/** TCP-connect to host:port; the snapshot is the open/closed/timeout word, so the generic diff fires on any reachability change. */
function probePort(target: string): Promise<ProbeResult> {
  const match = /^(?:([^:\s]+):)?(\d{1,5})$/.exec(target.trim())
  const host = match?.[1] ?? 'localhost'
  const port = Number(match?.[2])
  return new Promise(resolve => {
    let settled = false
    const socket = connect({ host, port })
    const settle = (word: string): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ snapshot: word, state: `${word} (${host}:${String(port)})` })
    }
    socket.setTimeout(PROBE_TIMEOUT_MS, () => { settle('timeout') })
    socket.on('connect', () => { settle('open') })
    socket.on('error', () => { settle('closed') })
  })
}

/** Dispatch one probe for a spec. Never throws: every failure mode is a state. */
export function probe(spec: SensorSpec): Promise<ProbeResult> {
  switch (spec.kind) {
    case 'file': return probeFile(spec.target)
    case 'command': return probeCommand(spec.target)
    case 'http': return probeHttp(spec.target)
    case 'process': return probeProcess(spec.target)
    case 'port': return probePort(spec.target)
    case 'webhook': return Promise.resolve({ snapshot: PLACEHOLDER_PUSH_ONLY, state: 'awaiting push' })
  }
}

/**
 * Transition decision: given the optional pattern and two consecutive
 * snapshots, decide whether the watched condition newly holds.
 *
 * - With a pattern: fire on the no-match → match edge (level-triggered would
 *   re-fire forever; the cooldown alone should not have to carry that).
 *   Placeholder snapshots never match, so the edge a content pattern waits
 *   for is placeholder → real matching content.
 * - Without a pattern: fire on any snapshot change after the baseline.
 */
export function shouldFire(
  pattern: string | undefined,
  previous: string | undefined,
  current: string,
): { fire: boolean; summary: string } {
  if (pattern !== undefined) {
    const regex = new RegExp(pattern, 'm')
    const was = previous !== undefined && !isPlaceholderSnapshot(previous) && regex.test(previous)
    const is = !isPlaceholderSnapshot(current) && regex.test(current)
    if (!was && is) {
      const match = regex.exec(current)
      return { fire: true, summary: `模式 /${pattern}/ 开始匹配: ${match?.[0] ?? ''}` }
    }
    return { fire: false, summary: '' }
  }
  if (previous === undefined) return { fire: false, summary: '' }
  if (previous !== current) return { fire: true, summary: '快照发生变化' }
  return { fire: false, summary: '' }
}
