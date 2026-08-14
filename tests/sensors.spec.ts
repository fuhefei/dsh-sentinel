import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
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

  it('never matches placeholder snapshots, so any-content patterns hold while the target is missing', () => {
    expect(shouldFire('[\\s\\S]+', undefined, '<absent>').fire).toBe(false)
    expect(shouldFire('[\\s\\S]+', '<absent>', '<absent>').fire).toBe(false)
    expect(shouldFire('s', undefined, '<unreachable>').fire).toBe(false)
    expect(shouldFire('.', undefined, '<none>').fire).toBe(false)
    expect(shouldFire('push', undefined, '<push-only>').fire).toBe(false)
  })

  it('fires on the placeholder to matching-content edge with a pattern', () => {
    const content = 'size=6 mtime=1\nhello\n'
    expect(shouldFire('[\\s\\S]+', '<absent>', content).fire).toBe(true)
    expect(shouldFire('hello', '<absent>', content).fire).toBe(true)
    expect(shouldFire('goodbye', '<absent>', content).fire).toBe(false)
  })

  it('does not re-arm a pattern fire when matching content disappears', () => {
    const content = 'size=6 mtime=1\nhello\n'
    expect(shouldFire('hello', content, '<absent>').fire).toBe(false)
    expect(shouldFire('hello', content, content).fire).toBe(false)
  })

  it('still fires without a pattern when the target appears or disappears', () => {
    expect(shouldFire(undefined, '<absent>', 'size=1 mtime=1\nx').fire).toBe(true)
    expect(shouldFire(undefined, 'size=1 mtime=1\nx', '<absent>').fire).toBe(true)
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

  it('reports port reachability as a state', async () => {
    const server = createServer(socket => { socket.end() })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as { port: number }
    const target = `127.0.0.1:${String(port)}`
    const open = await probe({ kind: 'port', target, intervalSeconds: 5 })
    expect(open.state).toContain('open')
    await new Promise<void>(resolve => server.close(() => resolve()))
    const closed = await probe({ kind: 'port', target, intervalSeconds: 5 })
    expect(closed.state).toContain('closed')
    const bare = await probe({ kind: 'port', target: String(port), intervalSeconds: 5 })
    expect(bare.snapshot).toBe(closed.snapshot)
  })

  it('snapshots only the tail of a large file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentinel-'))
    dirs.push(dir)
    const path = join(dir, 'big.log')
    // Head region (H) must fall outside the 8192-byte tail window.
    const head = 'H'.repeat(20_000)
    const middle = 'X'.repeat(9_000)
    const tail = 'TAIL-MARKER-end'
    await writeFile(path, `${head}${middle}${tail}`)
    const result = await probe({ kind: 'file', target: path, intervalSeconds: 5 })
    expect(result.snapshot).toContain('TAIL-MARKER-end')
    expect(result.snapshot).toContain('XXX')
    expect(result.snapshot).not.toContain('H'.repeat(100))
    expect(result.snapshot.length).toBeLessThan(9000)
    expect(result.state).toContain(String(head.length + middle.length + tail.length))
  })
})
