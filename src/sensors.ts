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
import { stat, readFile } from 'node:fs/promises'
import type { SensorSpec } from './domain.ts'

export interface ProbeResult {
  /** Canonical snapshot text (diffed against the previous probe). */
  readonly snapshot: string
  /** One-line state label used in transition summaries. */
  readonly state: string
}

const PROBE_TIMEOUT_MS = 10_000
const SNAPSHOT_TAIL_BYTES = 8192

/** Read the tail of a file plus its identity line; missing file is a state, not an error. */
async function probeFile(target: string): Promise<ProbeResult> {
  try {
    const info = await stat(target)
    let tail = ''
    if (info.isFile() && info.size > 0) {
      const buffer = await readFile(target)
      tail = buffer.subarray(Math.max(0, buffer.length - SNAPSHOT_TAIL_BYTES)).toString('utf8')
    }
    return {
      snapshot: `size=${String(info.size)} mtime=${info.mtimeMs.toFixed(0)}\n${tail}`,
      state: `exists (${String(info.size)} bytes)`,
    }
  } catch {
    return { snapshot: '<absent>', state: 'absent' }
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

/** GET the URL; snapshot = status + body head. Network failure is a state. */
async function probeHttp(target: string): Promise<ProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(target, { signal: controller.signal, redirect: 'manual' })
    const body = await response.text()
    const head = body.length > SNAPSHOT_TAIL_BYTES ? body.slice(0, SNAPSHOT_TAIL_BYTES) : body
    return {
      snapshot: `status=${String(response.status)}\n${head}`,
      state: `HTTP ${String(response.status)}`,
    }
  } catch {
    return { snapshot: '<unreachable>', state: 'unreachable' }
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
        resolve({ snapshot: '<none>', state: 'no process' })
        return
      }
      resolve({
        snapshot: lines.join('\n'),
        state: `${String(lines.length)} process(es)`,
      })
    })
  })
}

/** Dispatch one probe for a spec. Never throws: every failure mode is a state. */
export function probe(spec: SensorSpec): Promise<ProbeResult> {
  switch (spec.kind) {
    case 'file': return probeFile(spec.target)
    case 'command': return probeCommand(spec.target)
    case 'http': return probeHttp(spec.target)
    case 'process': return probeProcess(spec.target)
    case 'webhook': return Promise.resolve({ snapshot: '<push-only>', state: 'awaiting push' })
  }
}

/**
 * Transition decision: given the optional pattern and two consecutive
 * snapshots, decide whether the watched condition newly holds.
 *
 * - With a pattern: fire on the no-match → match edge (level-triggered would
 *   re-fire forever; the cooldown alone should not have to carry that).
 * - Without a pattern: fire on any snapshot change after the baseline.
 */
export function shouldFire(
  pattern: string | undefined,
  previous: string | undefined,
  current: string,
): { fire: boolean; summary: string } {
  if (pattern !== undefined) {
    const regex = new RegExp(pattern, 'm')
    const was = previous !== undefined && regex.test(previous)
    const is = regex.test(current)
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
