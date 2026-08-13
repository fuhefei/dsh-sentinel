import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { probe, shouldFire } from '../src/sensors.ts'

describe('shouldFire', () => {
  it('holds on the baseline probe without a pattern', () => {
    expect(shouldFire(undefined, undefined, 'a').fire).toBe(false)
  })

  it('fires on any change after the baseline without a pattern', () => {
    expect(shouldFire(undefined, 'a', 'b').fire).toBe(true)
    expect(shouldFire(undefined, 'a', 'a').fire).toBe(false)
  })

  it('fires only on the no-match to match edge with a pattern', () => {
    expect(shouldFire('ready', undefined, 'not yet').fire).toBe(false)
    expect(shouldFire('ready', 'not yet', 'ready now').fire).toBe(true)
    expect(shouldFire('ready', 'ready now', 'still ready').fire).toBe(false)
  })

  it('reports the matched text in the summary', () => {
    const decision = shouldFire('INSTALL-\\w+', 'building', 'INSTALL-OK done')
    expect(decision.summary).toContain('INSTALL-OK')
  })
})

describe('probe', () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
  })

  it('captures file snapshots and treats absence as a state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentinel-'))
    dirs.push(dir)
    const path = join(dir, 'log.txt')
    const absent = await probe({ kind: 'file', target: path, intervalSeconds: 5 })
    expect(absent.state).toBe('absent')
    await writeFile(path, 'hello')
    const present = await probe({ kind: 'file', target: path, intervalSeconds: 5 })
    expect(present.state).toContain('5 bytes')
    expect(present.snapshot).toContain('hello')
    const transition = shouldFire(undefined, absent.snapshot, present.snapshot)
    expect(transition.fire).toBe(true)
  })

  it('captures command exit and output', async () => {
    const ok = await probe({ kind: 'command', target: 'printf sentinel-ok', intervalSeconds: 5 })
    expect(ok.state).toBe('exit 0')
    expect(ok.snapshot).toContain('sentinel-ok')
    const bad = await probe({ kind: 'command', target: 'exit 3', intervalSeconds: 5 })
    expect(bad.state).toBe('exit 3')
  })

  it('treats unreachable http as a state, not an error', async () => {
    const result = await probe({ kind: 'http', target: 'http://127.0.0.1:1/never', intervalSeconds: 5 })
    expect(result.state).toBe('unreachable')
  })

  it('lists processes without shell interpolation hazards', async () => {
    const result = await probe({ kind: 'process', target: "definitely-no-such-proc'; echo pwned", intervalSeconds: 5 })
    expect(result.snapshot).not.toContain('pwned')
    expect(result.state).toBe('no process')
  })
})
